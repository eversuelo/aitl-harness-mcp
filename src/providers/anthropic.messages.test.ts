import assert from "node:assert/strict";
import { test } from "node:test";
import { toAnthropicMessages } from "./anthropic.js";

test("assistant tool_calls become tool_use content blocks", () => {
  const out = toAnthropicMessages([
    {
      role: "assistant",
      content: "let me write that",
      tool_calls: [{ id: "call_1", name: "write_file", input: { path: "a.txt", content: "hi" } }],
    },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, "assistant");
  const blocks = out[0].content as unknown as { type: string; [k: string]: unknown }[];
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["text", "tool_use"],
  );
  assert.equal(blocks[1].id, "call_1");
  assert.equal(blocks[1].name, "write_file");
  assert.deepEqual(blocks[1].input, { path: "a.txt", content: "hi" });
});

test("tool results become tool_result blocks inside a user turn", () => {
  const out = toAnthropicMessages([
    { role: "user", content: "write a file" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", name: "write_file", input: {} }] },
    { role: "tool", tool_call_id: "call_1", content: "wrote 2 chars" },
  ]);
  assert.equal(out.length, 3);
  assert.equal(out[2].role, "user");
  const blocks = out[2].content as unknown as { type: string; tool_use_id?: string; content?: string }[];
  assert.equal(blocks[0].type, "tool_result");
  assert.equal(blocks[0].tool_use_id, "call_1");
  assert.equal(blocks[0].content, "wrote 2 chars");
});

test("consecutive tool results merge into ONE user message (parallel tool calls)", () => {
  const out = toAnthropicMessages([
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "c1", name: "read_file", input: {} },
        { id: "c2", name: "read_file", input: {} },
      ],
    },
    { role: "tool", tool_call_id: "c1", content: "one" },
    { role: "tool", tool_call_id: "c2", content: "two" },
  ]);
  assert.equal(out.length, 2); // assistant + ONE merged user turn
  const blocks = out[1].content as unknown as { type: string; tool_use_id?: string }[];
  assert.equal(blocks.length, 2);
  assert.deepEqual(
    blocks.map((b) => b.tool_use_id),
    ["c1", "c2"],
  );
});

test("a tool result without an id degrades to a plain text block", () => {
  const out = toAnthropicMessages([{ role: "tool", tool_call_id: null, content: "orphan result" }]);
  assert.equal(out[0].role, "user");
  const blocks = out[0].content as unknown as { type: string; text?: string }[];
  assert.equal(blocks[0].type, "text");
  assert.match(blocks[0].text ?? "", /orphan result/);
});

test("an empty assistant turn is skipped and the flanking user turns merge", () => {
  const out = toAnthropicMessages([
    { role: "user", content: "hi" },
    { role: "assistant", content: "" },
    { role: "user", content: "still there?" },
  ]);
  // With the empty assistant gone, the two user turns become ONE message
  // with two text blocks (consecutive same-role turns are merged).
  assert.equal(out.length, 1);
  assert.equal(out[0].role, "user");
  const blocks = out[0].content as unknown as { type: string; text?: string }[];
  assert.deepEqual(
    blocks.map((b) => b.text),
    ["hi", "still there?"],
  );
});

test("a tool_use without id gets a synthesized one", () => {
  const out = toAnthropicMessages([
    { role: "assistant", content: "", tool_calls: [{ name: "shell", input: { cmd: "ls" } }] },
  ]);
  const blocks = out[0].content as unknown as { type: string; id?: string }[];
  assert.equal(blocks[0].type, "tool_use");
  assert.ok((blocks[0].id ?? "").length > 0);
});
