import assert from "node:assert/strict";
import { test } from "node:test";
import { councilFlow, delegateFlow, exportTasksFlow, planFlow, type TaskIO } from "./task.js";
import type { HostAvailability } from "./taskLogic.js";

/** Headless TaskIO: scripted answers in, transcript out. Nothing touches the TTY. */
class FakeIO implements TaskIO {
  out: string[] = [];
  private answers: string[];
  constructor(answers: string[] = []) {
    this.answers = [...answers];
  }
  write(text: string): void {
    this.out.push(text);
  }
  async question(prompt: string): Promise<string> {
    this.out.push(prompt);
    return this.answers.shift() ?? "";
  }
  get text(): string {
    return this.out.join("");
  }
}

const host = (name: string, available = true): HostAvailability => ({
  name,
  available,
  via: available ? "path" : null,
  command: name,
});

// Every scenario below exits BEFORE the flows reach a provider, a host child, or
// Mongo — that is the point: cancellation and guard paths must be side-effect-free.

test("planFlow: empty task cancels before touching provider or backend", async () => {
  const io = new FakeIO([""]);
  await planFlow("proj", io);
  assert.match(io.text, /\(cancelado\)/);
});

test("delegateFlow: no available hosts short-circuits", async () => {
  const io = new FakeIO();
  await delegateFlow("proj", io, [host("claude-code", false)]);
  assert.match(io.text, /Sin hosts disponibles/);
});

test("delegateFlow: empty answer at the host picker cancels silently", async () => {
  const io = new FakeIO([""]);
  await delegateFlow("proj", io, [host("claude-code")]);
  assert.match(io.text, /1\. claude-code/);
  assert.ok(!io.text.includes("Tarea a delegar"));
});

test("delegateFlow: out-of-range host choice is rejected", async () => {
  const io = new FakeIO(["7"]);
  await delegateFlow("proj", io, [host("claude-code"), host("codex")]);
  assert.match(io.text, /opción inválida/);
});

test("delegateFlow: non-numeric host choice is rejected", async () => {
  const io = new FakeIO(["x"]);
  await delegateFlow("proj", io, [host("claude-code")]);
  assert.match(io.text, /opción inválida/);
});

test("delegateFlow: picking a host then an empty task cancels", async () => {
  const io = new FakeIO(["2", ""]);
  await delegateFlow("proj", io, [host("claude-code"), host("codex")]);
  assert.match(io.text, /\(cancelado\)/);
});

test("delegateFlow: only available hosts are offered", async () => {
  const io = new FakeIO([""]);
  await delegateFlow("proj", io, [host("claude-code", false), host("codex")]);
  assert.ok(!io.text.includes("claude-code"));
  assert.match(io.text, /1\. codex/);
});

test("councilFlow: empty task cancels before deliberating", async () => {
  const io = new FakeIO([""]);
  await councilFlow("proj", io, { proponents: ["a", "b"], judge: "provider:p" }, [host("a"), host("b")]);
  assert.match(io.text, /\(cancelado\)/);
});

test("exportTasksFlow: empty dir cancels before touching Mongo", async () => {
  const io = new FakeIO([""]);
  await exportTasksFlow("proj", io);
  assert.match(io.text, /\(cancelado\)/);
});
