import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatTurn, StreamDelta } from "../providers/base.js";
import { consumeStream } from "./stream.js";

const TURN: ChatTurn = {
  text: "hello world",
  tool_calls: [],
  usage: { input: 10, output: 2 },
  stop_reason: "stop",
};

async function* fakeStream(): AsyncGenerator<StreamDelta, ChatTurn, void> {
  yield { type: "text", text: "hello " };
  yield { type: "text", text: "world" };
  return TURN;
}

test("consumeStream forwards deltas in order and resolves the generator's return", async () => {
  const seen: string[] = [];
  const turn = await consumeStream(fakeStream(), (d) => seen.push(d.text));
  assert.deepEqual(seen, ["hello ", "world"]);
  assert.deepEqual(turn, TURN);
});

test("a generator that throws rejects consumeStream (so withRetry can retry the turn)", async () => {
  async function* broken(): AsyncGenerator<StreamDelta, ChatTurn, void> {
    yield { type: "text", text: "partial" };
    throw new Error("connection reset");
  }
  const seen: string[] = [];
  await assert.rejects(
    () => consumeStream(broken(), (d) => seen.push(d.text)),
    /connection reset/,
  );
  assert.deepEqual(seen, ["partial"]); // deltas before the failure were delivered
});
