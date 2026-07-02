import assert from "node:assert/strict";
import { test } from "node:test";
import type OpenAI from "openai";
import { finishStream, foldStreamChunk, newStreamAccState } from "./openai.js";

type Chunk = OpenAI.ChatCompletionChunk;

/** Minimal chunk factory — only the fields the accumulator reads. */
function chunk(v: {
  content?: string;
  tool_calls?: { index: number; id?: string; name?: string; args?: string }[];
  finish?: string;
  usage?: { prompt: number; completion: number };
  noChoices?: boolean;
}): Chunk {
  return {
    id: "c",
    object: "chat.completion.chunk",
    created: 0,
    model: "m",
    choices: v.noChoices
      ? []
      : [
          {
            index: 0,
            delta: {
              ...(v.content !== undefined ? { content: v.content } : {}),
              ...(v.tool_calls
                ? {
                    tool_calls: v.tool_calls.map((tc) => ({
                      index: tc.index,
                      ...(tc.id ? { id: tc.id } : {}),
                      ...(tc.name || tc.args
                        ? { function: { ...(tc.name ? { name: tc.name } : {}), ...(tc.args ? { arguments: tc.args } : {}) } }
                        : {}),
                    })),
                  }
                : {}),
            },
            finish_reason: (v.finish ?? null) as "stop" | null,
          },
        ],
    ...(v.usage ? { usage: { prompt_tokens: v.usage.prompt, completion_tokens: v.usage.completion, total_tokens: v.usage.prompt + v.usage.completion } } : {}),
  } as Chunk;
}

test("plain text chunks accumulate and yield per-chunk deltas", () => {
  const s = newStreamAccState();
  assert.equal(foldStreamChunk(s, chunk({ content: "Hel" })), "Hel");
  assert.equal(foldStreamChunk(s, chunk({ content: "lo" })), "lo");
  assert.equal(foldStreamChunk(s, chunk({ finish: "stop" })), "");
  const turn = finishStream(s);
  assert.equal(turn.text, "Hello");
  assert.deepEqual(turn.tool_calls, []);
  assert.equal(turn.stop_reason, "stop");
});

test("a fragmented tool call reassembles (name first, arguments split across chunks)", () => {
  const s = newStreamAccState();
  foldStreamChunk(s, chunk({ tool_calls: [{ index: 0, id: "call_1", name: "write_file" }] }));
  foldStreamChunk(s, chunk({ tool_calls: [{ index: 0, args: '{"path":"a.t' }] }));
  foldStreamChunk(s, chunk({ tool_calls: [{ index: 0, args: 'xt","content":"hi"}' }] }));
  foldStreamChunk(s, chunk({ finish: "tool_calls" }));
  const turn = finishStream(s);
  assert.deepEqual(turn.tool_calls, [
    { id: "call_1", name: "write_file", input: { path: "a.txt", content: "hi" } },
  ]);
  assert.equal(turn.stop_reason, "tool_calls");
});

test("two parallel tool calls interleaved by index stay separate and ordered", () => {
  const s = newStreamAccState();
  foldStreamChunk(s, chunk({ tool_calls: [{ index: 0, id: "a", name: "read_file", args: '{"path"' }] }));
  foldStreamChunk(s, chunk({ tool_calls: [{ index: 1, id: "b", name: "shell", args: '{"comm' }] }));
  foldStreamChunk(s, chunk({ tool_calls: [{ index: 0, args: ':"x.txt"}' }] }));
  foldStreamChunk(s, chunk({ tool_calls: [{ index: 1, args: 'and":"ls"}' }] }));
  const turn = finishStream(s);
  assert.deepEqual(
    turn.tool_calls.map((t) => t.name),
    ["read_file", "shell"],
  );
  assert.deepEqual(turn.tool_calls[0].input, { path: "x.txt" });
  assert.deepEqual(turn.tool_calls[1].input, { command: "ls" });
});

test("the usage-only final chunk (empty choices) is captured", () => {
  const s = newStreamAccState();
  foldStreamChunk(s, chunk({ content: "ok" }));
  assert.equal(foldStreamChunk(s, chunk({ noChoices: true, usage: { prompt: 12, completion: 3 } })), "");
  const turn = finishStream(s);
  assert.deepEqual(turn.usage, { input: 12, output: 3 });
});

test("no usage chunk (older LM Studio) degrades to zero tokens", () => {
  const s = newStreamAccState();
  foldStreamChunk(s, chunk({ content: "ok", finish: "stop" }));
  assert.deepEqual(finishStream(s).usage, { input: 0, output: 0 });
});

test("malformed tool arguments degrade to {} like chat() does", () => {
  const s = newStreamAccState();
  foldStreamChunk(s, chunk({ tool_calls: [{ index: 0, id: "x", name: "shell", args: "{oops" }] }));
  assert.deepEqual(finishStream(s).tool_calls, [{ id: "x", name: "shell", input: {} }]);
});
