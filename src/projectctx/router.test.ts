import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { routeSkills } from "./router.js";
import type { DefinitionStore } from "./store.js";

type Rec = Record<string, unknown>;

/** Stub store: routeSkills only touches `search` and `list`. */
function stubStore(opts: {
  search?: (project: string, query: string, limit: number) => Promise<Rec[]>;
  list?: (project: string, o: { limit: number }) => Promise<Rec[]>;
}): DefinitionStore {
  return {
    search: opts.search ?? (async () => []),
    list: opts.list ?? (async () => []),
  } as unknown as DefinitionStore;
}

const skill = (name: string, extra: Rec = {}): Rec => ({
  name,
  description: `desc de ${name}`,
  content: `instrucciones de ${name}`,
  ...extra,
});

describe("routeSkills — selección", () => {
  it("inyecta los hits léxicos con heading e instrucción por defecto", async () => {
    const store = stubStore({ search: async () => [skill("alpha")] });
    const { preamble, selected } = await routeSkills("p", "tarea alpha", { store, rerank: false });
    assert.deepEqual(selected, ["alpha"]);
    assert.match(preamble, /^## Project skills \(relevant capabilities for this task\)/);
    assert.match(preamble, /Apply these project skills when they fit the work/);
    assert.match(preamble, /### alpha — desc de alpha\ninstrucciones de alpha/);
  });

  it("cae a recencia (list) cuando search lanza", async () => {
    const store = stubStore({
      search: async () => {
        throw new Error("sin índice $text");
      },
      list: async () => [skill("reciente")],
    });
    const { selected } = await routeSkills("p", "cualquier tarea", { store, rerank: false });
    assert.deepEqual(selected, ["reciente"]);
  });

  it("cae a recencia cuando search no encuentra nada", async () => {
    let listCalled = false;
    const store = stubStore({
      search: async () => [],
      list: async () => {
        listCalled = true;
        return [skill("por-recencia")];
      },
    });
    const { selected } = await routeSkills("p", "x", { store, rerank: false });
    assert.equal(listCalled, true);
    assert.deepEqual(selected, ["por-recencia"]);
  });

  it("sin candidatos devuelve preámbulo vacío (el run nunca se rompe)", async () => {
    const store = stubStore({});
    assert.deepEqual(await routeSkills("p", "x", { store, rerank: false }), {
      preamble: "",
      selected: [],
    });
  });

  it("respeta el límite de skills inyectadas (default 3)", async () => {
    const pool = ["a", "b", "c", "d", "e"].map((n) => skill(n));
    const store = stubStore({ search: async () => pool });
    const { selected } = await routeSkills("p", "x", { store, rerank: false });
    assert.equal(selected.length, 3);
  });

  it("omite registros sin content (nada que inyectar)", async () => {
    const store = stubStore({
      search: async () => [skill("vacia", { content: "" }), skill("llena")],
    });
    const { selected } = await routeSkills("p", "x", { store, rerank: false });
    assert.deepEqual(selected, ["llena"]);
  });
});

describe("routeSkills — modo agents (ADR-0063)", () => {
  it("filter excluye los roles guardados en la colección agents", async () => {
    const store = stubStore({
      search: async () => [
        skill("security", { metadata: { kind: "role" } }),
        skill("harness-engineer", { metadata: { kind: "agent" } }),
      ],
    });
    const { selected } = await routeSkills("p", "x", {
      store,
      rerank: false,
      filter: (rec) => (rec as { metadata?: { kind?: string } }).metadata?.kind !== "role",
    });
    assert.deepEqual(selected, ["harness-engineer"]);
  });

  it("heading e instrucción personalizados reemplazan los defaults", async () => {
    const store = stubStore({ search: async () => [skill("brief")] });
    const { preamble } = await routeSkills("p", "x", {
      store,
      rerank: false,
      heading: "## Project agents (operating briefs relevant to this task)",
      instruction: "Follow these agent briefs when acting in their domain.",
    });
    assert.match(preamble, /^## Project agents /);
    assert.match(preamble, /Follow these agent briefs/);
    assert.doesNotMatch(preamble, /Project skills/);
  });
});

describe("routeSkills — presupuesto", () => {
  it("recorta el content al presupuesto de caracteres (la cabecera no cuenta)", async () => {
    const store = stubStore({ search: async () => [skill("larga", { content: "x".repeat(500) })] });
    const { preamble, selected } = await routeSkills("p", "x", {
      store,
      rerank: false,
      maxChars: 160,
    });
    assert.deepEqual(selected, ["larga"]);
    // El presupuesto acota los bloques de skill; heading+instrucción van aparte.
    assert.ok(preamble.includes("### larga"));
    assert.ok(!preamble.includes("x".repeat(200)), "el content no se recortó al presupuesto");
  });

  it("si ni el primer bloque cabe, no inyecta nada", async () => {
    const store = stubStore({ search: async () => [skill("imposible")] });
    const out = await routeSkills("p", "x", { store, rerank: false, maxChars: 10 });
    assert.deepEqual(out, { preamble: "", selected: [] });
  });
});
