import assert from "node:assert/strict";
import { test } from "node:test";
import { toOpenAiMessages } from "./openai.js";

test("assistant tool_calls are converted from harness shape to OpenAI wire shape", () => {
  // Regression: the loop re-sends {id,name,input}; OpenAI needs
  // {id,type:"function",function:{name,arguments:<json>}}. Without this the second
  // turn after any tool call is rejected ("Invalid 'messages' in payload").
  const out = toOpenAiMessages([
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_1", name: "write_file", input: { path: "a.txt", content: "hi" } }],
    },
  ]);
  const msg = out[0] as { role: string; content: unknown; tool_calls: { id: string; type: string; function: { name: string; arguments: string } }[] };
  assert.equal(msg.role, "assistant");
  assert.equal(msg.content, null); // "" → null on a tool-only assistant turn
  assert.equal(msg.tool_calls[0].type, "function");
  assert.equal(msg.tool_calls[0].function.name, "write_file");
  assert.deepEqual(JSON.parse(msg.tool_calls[0].function.arguments), { path: "a.txt", content: "hi" });
});

test("plain user/tool/system messages pass through unchanged", () => {
  const input = [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    { role: "tool", tool_call_id: "call_1", content: "wrote 2 chars" },
  ];
  const out = toOpenAiMessages(input);
  assert.deepEqual(out, input);
});

test("an assistant message with text and no tool_calls is untouched", () => {
  const input = [{ role: "assistant", content: "just text" }];
  assert.deepEqual(toOpenAiMessages(input), input);
});
