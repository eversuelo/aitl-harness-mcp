import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatTurn, StreamDelta } from "../providers/base.js";
import { consumeStream, StreamInterrupted } from "./stream.js";

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

test("an already-aborted signal interrupts before consuming anything", async () => {
  const ctl = new AbortController();
  ctl.abort();
  const seen: string[] = [];
  await assert.rejects(
    () => consumeStream(fakeStream(), (d) => seen.push(d.text), { signal: ctl.signal }),
    (err: unknown) => err instanceof StreamInterrupted,
  );
  assert.deepEqual(seen, []);
});

test("aborting mid-stream throws StreamInterrupted and closes the generator", async () => {
  const ctl = new AbortController();
  let closed = false;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  async function* endless(): AsyncGenerator<StreamDelta, ChatTurn, void> {
    try {
      // Streams forever, like a model dumping a whole file: abort is the only exit.
      for (let i = 0; ; i++) {
        yield { type: "text", text: i === 0 ? "before " : `tick${i} ` };
        await sleep(5);
      }
    } finally {
      closed = true; // gen.return() reached the finally → underlying stream released
    }
  }
  const seen: string[] = [];
  const pending = assert.rejects(
    () => consumeStream(endless(), (d) => seen.push(d.text), { signal: ctl.signal, idleMs: 0 }),
    (err: unknown) => err instanceof StreamInterrupted,
  );
  setTimeout(() => ctl.abort(), 25);
  await pending;
  assert.equal(seen[0], "before "); // deltas flowed until the abort
  await sleep(50); // gen.return() settles once the in-flight step does (best-effort close)
  assert.equal(closed, true);
});

test("StreamInterrupted is not classified as transient (never retried)", async () => {
  const { isTransientError } = await import("../util/retry.js");
  assert.equal(isTransientError(new StreamInterrupted()), false);
});
