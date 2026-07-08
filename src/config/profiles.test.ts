import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetBootProfileForTests,
  _setDotenvKeysForTests,
  activeProfileName,
  captureBootProfile,
  layerLookup,
  pendingRestartKeys,
  profileFilePath,
  readProfileFile,
  resolvedEnv,
  resolveProfile,
  resolveProfileSources,
  writeConfigFile,
  writeProfilesManifest,
} from "./store.js";
import {
  deleteProfile,
  listProfiles,
  resolveProfileView,
  setActiveProfile,
  validateProfileName,
  writeProfile,
} from "./profiles.js";

// Env keys the tests mutate; they may exist in the developer's real env or repo
// .env, so they are saved/cleared per test and the dotenv provenance is stubbed.
const TEST_ENV_KEYS = ["AITL_HOME", "AITL_PROFILE", "MONGODB_DB", "MODEL_PRIMARY", "MEMORY_MAX_DOCS"];

/** Isolated ~/.aitl in a temp dir + clean env layers; restores everything after. */
async function withCleanConfig<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "aitl-profiles-"));
  const saved: Record<string, string | undefined> = {};
  for (const k of TEST_ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.AITL_HOME = dir;
  _setDotenvKeysForTests(new Set());
  _resetBootProfileForTests();
  try {
    return await fn(dir);
  } finally {
    _setDotenvKeysForTests(null);
    _resetBootProfileForTests();
    for (const k of TEST_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(dir, { recursive: true, force: true });
  }
}

// ── layerLookup (pure precedence) ────────────────────────────────────────────

test("layerLookup: real env beats profile, dotenv and file", () => {
  const layers = {
    env: { MONGODB_DB: "from-env" } as NodeJS.ProcessEnv,
    dotenvKeys: new Set<string>(),
    profile: { MONGODB_DB: "from-profile" },
    file: { MONGODB_DB: "from-file" },
  };
  assert.deepEqual(layerLookup("MONGODB_DB", layers), { value: "from-env", source: "env" });
});

test("layerLookup: active profile beats a dotenv-provided value", () => {
  const layers = {
    env: { MONGODB_DB: "from-dotenv" } as NodeJS.ProcessEnv,
    dotenvKeys: new Set(["MONGODB_DB"]),
    profile: { MONGODB_DB: "from-profile" },
    file: { MONGODB_DB: "from-file" },
  };
  assert.deepEqual(layerLookup("MONGODB_DB", layers), { value: "from-profile", source: "profile" });
});

test("layerLookup: dotenv beats the base config file", () => {
  const layers = {
    env: { MONGODB_DB: "from-dotenv" } as NodeJS.ProcessEnv,
    dotenvKeys: new Set(["MONGODB_DB"]),
    profile: {},
    file: { MONGODB_DB: "from-file" },
  };
  assert.deepEqual(layerLookup("MONGODB_DB", layers), { value: "from-dotenv", source: "dotenv" });
});

test("layerLookup: falls to file, then to nothing; '' is unset at every layer", () => {
  const base = { env: {} as NodeJS.ProcessEnv, dotenvKeys: new Set<string>(), profile: {}, file: {} };
  assert.deepEqual(layerLookup("MONGODB_DB", { ...base, file: { MONGODB_DB: "f" } }), {
    value: "f",
    source: "file",
  });
  assert.deepEqual(layerLookup("MONGODB_DB", base), {});
  // Empty strings never shadow lower layers.
  assert.deepEqual(
    layerLookup("MONGODB_DB", {
      env: { MONGODB_DB: "" } as NodeJS.ProcessEnv,
      dotenvKeys: new Set<string>(),
      profile: { MONGODB_DB: "" },
      file: { MONGODB_DB: "f" },
    }),
    { value: "f", source: "file" },
  );
});

// ── profile CRUD ─────────────────────────────────────────────────────────────

test("validateProfileName rejects bad and reserved names", () => {
  for (const bad of ["", "Trabajo", "-x", "a b", "../evil", "config", "profiles", "x".repeat(33)]) {
    assert.throws(() => validateProfileName(bad), /Invalid profile name/);
  }
  for (const ok of ["trabajo", "personal", "work-2", "a.b_c"]) {
    validateProfileName(ok);
  }
});

test("writeProfile/readProfileFile roundtrip; null unsets; unknown keys throw", async () => {
  await withCleanConfig(async () => {
    await writeProfile("trabajo", { MONGODB_DB: "aitl_work", MODEL_PRIMARY: "anthropic" });
    assert.deepEqual(readProfileFile("trabajo"), {
      MONGODB_DB: "aitl_work",
      MODEL_PRIMARY: "anthropic",
    });
    // merge (default): only touched keys change; null deletes.
    await writeProfile("trabajo", { MODEL_PRIMARY: null });
    assert.deepEqual(readProfileFile("trabajo"), { MONGODB_DB: "aitl_work" });
    // merge:false replaces the whole overlay.
    await writeProfile("trabajo", { MEMORY_MAX_DOCS: "9" }, { merge: false });
    assert.deepEqual(readProfileFile("trabajo"), { MEMORY_MAX_DOCS: "9" });
    await assert.rejects(writeProfile("trabajo", { NOT_A_KEY: "x" }), /Unknown config key/);
  });
});

test("readProfileFile: missing/malformed/invalid names → {}", async () => {
  await withCleanConfig(async () => {
    assert.deepEqual(readProfileFile("missing"), {});
    assert.deepEqual(readProfileFile("../evil"), {});
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    const path = profileFilePath("broken");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "not json", "utf-8");
    assert.deepEqual(readProfileFile("broken"), {});
  });
});

test("activeProfileName: AITL_PROFILE env ('' = none) overrides the manifest", async () => {
  await withCleanConfig(async () => {
    assert.equal(activeProfileName(), null);
    await writeProfile("personal", { MONGODB_DB: "aitl_personal" });
    await setActiveProfile("personal");
    assert.equal(activeProfileName(), "personal");
    process.env.AITL_PROFILE = "trabajo";
    assert.equal(activeProfileName(), "trabajo");
    process.env.AITL_PROFILE = "";
    assert.equal(activeProfileName(), null);
    delete process.env.AITL_PROFILE;
    assert.equal(activeProfileName(), "personal");
  });
});

test("setActiveProfile rejects a missing profile; deleteProfile refuses the active one", async () => {
  await withCleanConfig(async () => {
    await assert.rejects(setActiveProfile("nope"), /does not exist/);
    await writeProfile("personal", { MONGODB_DB: "aitl_personal" });
    await setActiveProfile("personal");
    await assert.rejects(deleteProfile("personal"), /is active/);
    await setActiveProfile(null);
    assert.equal(await deleteProfile("personal"), true);
    assert.equal(await deleteProfile("personal"), false); // already gone
  });
});

test("listProfiles: sorted, with keys and the active marker", async () => {
  await withCleanConfig(async () => {
    assert.deepEqual(listProfiles(), []);
    await writeProfile("trabajo", { MONGODB_DB: "aitl_work" });
    await writeProfile("personal", { MONGODB_DB: "aitl_personal", MODEL_PRIMARY: "lmstudio" });
    await setActiveProfile("trabajo");
    const rows = listProfiles();
    assert.deepEqual(
      rows.map((r) => ({ name: r.name, active: r.active })),
      [
        { name: "personal", active: false },
        { name: "trabajo", active: true },
      ],
    );
    assert.deepEqual(rows[0]?.keys.sort(), ["MODEL_PRIMARY", "MONGODB_DB"]);
  });
});

test("a corrupt manifest degrades to no active profile", async () => {
  await withCleanConfig(async (dir) => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "profiles.json"), "{broken", "utf-8");
    assert.equal(activeProfileName(), null);
    await writeProfilesManifest({ active: null });
    assert.equal(await readFile(join(dir, "profiles.json"), "utf-8"), '{\n  "active": null\n}\n');
  });
});

// ── full-stack resolution + boot snapshot ────────────────────────────────────

test("resolvedEnv: active profile overlays the base file; real env wins over both", async () => {
  await withCleanConfig(async () => {
    await writeConfigFile({ MONGODB_DB: "aitl", MODEL_PRIMARY: "openrouter" }, { merge: false });
    assert.equal(resolvedEnv("MONGODB_DB"), "aitl");
    await writeProfile("trabajo", { MONGODB_DB: "aitl_work" });
    await setActiveProfile("trabajo");
    assert.equal(resolvedEnv("MONGODB_DB"), "aitl_work"); // overlay wins
    assert.equal(resolvedEnv("MODEL_PRIMARY"), "openrouter"); // falls through
    process.env.MONGODB_DB = "from-real-env";
    assert.equal(resolvedEnv("MONGODB_DB"), "from-real-env"); // real env wins
    assert.equal(resolveProfileSources().MONGODB_DB, "env");
    delete process.env.MONGODB_DB;
    assert.equal(resolveProfileSources().MONGODB_DB, "profile");
    assert.equal(resolveProfileSources().MODEL_PRIMARY, "file");
  });
});

test("pendingRestartKeys: empty without a snapshot; diffs after config changes", async () => {
  await withCleanConfig(async () => {
    await writeConfigFile({ MONGODB_DB: "aitl" }, { merge: false });
    assert.deepEqual(pendingRestartKeys(), []); // no snapshot yet
    captureBootProfile();
    assert.deepEqual(pendingRestartKeys(), []);
    await writeProfile("personal", { MONGODB_DB: "aitl_personal", MEMORY_MAX_DOCS: "7" });
    await setActiveProfile("personal");
    assert.deepEqual(pendingRestartKeys().sort(), ["MEMORY_MAX_DOCS", "MONGODB_DB"]);
    await setActiveProfile(null);
    assert.deepEqual(pendingRestartKeys(), []);
  });
});

test("resolveProfileView masks secrets and redacts Mongo URIs", async () => {
  await withCleanConfig(async () => {
    await writeProfile("trabajo", {
      MONGODB_URI: "mongodb+srv://user:pass@work.example.net/",
      ANTHROPIC_API_KEY: "sk-ant-super-secret-1234",
      MONGODB_DB: "aitl_work",
    });
    const view = resolveProfileView("trabajo");
    assert.equal(view.MONGODB_URI, "mongodb+srv://<credentials>@work.example.net/");
    assert.equal(view.ANTHROPIC_API_KEY, "••••1234");
    assert.equal(view.MONGODB_DB, "aitl_work");
    const raw = resolveProfileView("trabajo", { includeSecrets: true });
    assert.equal(raw.ANTHROPIC_API_KEY, "sk-ant-super-secret-1234");
  });
});

test("resolveProfile (masked) reflects the active profile layer", async () => {
  await withCleanConfig(async () => {
    await writeConfigFile({ MONGODB_DB: "aitl" }, { merge: false });
    await writeProfile("trabajo", { MONGODB_DB: "aitl_work" });
    await setActiveProfile("trabajo");
    assert.equal(resolveProfile().MONGODB_DB, "aitl_work");
  });
});
