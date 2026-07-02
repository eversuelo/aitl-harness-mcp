import assert from "node:assert/strict";
import { test } from "node:test";
import { makeMessage } from "./message.model.js";

test("an assistant turn with empty text (pure tool_call) validates", () => {
  // Regression: `content: required` rejected "" (Mongoose truthiness) and crashed the
  // FIRST live loop turn that answered with tool_calls only (gemma-4 via LM Studio).
  const msg = makeMessage({
    project: "demo",
    run_id: "r1",
    idx: 1,
    role: "assistant",
    content: "",
    tool_calls: [{ id: "call_1", name: "write_file", input: { path: "a.txt", content: "hi" } }],
  });
  assert.equal(msg.content, "");
  assert.equal(msg.tool_calls.length, 1);
});

test("a normal user turn still validates and keeps its content", () => {
  const msg = makeMessage({ project: "demo", run_id: "r1", idx: 0, role: "user", content: "hola" });
  assert.equal(msg.content, "hola");
});
