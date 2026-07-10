import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STALL_FEEDBACK, StallTracker, progressSignature } from "./stall.js";

describe("progressSignature", () => {
  it("is stable for identical actions + workspace", () => {
    const a = progressSignature([{ name: "shell", input: { cmd: "ls" } }], "ws1");
    const b = progressSignature([{ name: "shell", input: { cmd: "ls" } }], "ws1");
    assert.equal(a, b);
  });

  it("differs when tool args change", () => {
    const a = progressSignature([{ name: "shell", input: { cmd: "ls" } }], "ws1");
    const b = progressSignature([{ name: "shell", input: { cmd: "pwd" } }], "ws1");
    assert.notEqual(a, b);
  });

  it("differs when the workspace changed (same actions still count as progress)", () => {
    const calls = [{ name: "write_file", input: { path: "a.ts" } }];
    assert.notEqual(progressSignature(calls, "before"), progressSignature(calls, "after"));
  });

  it("treats a missing input as {}", () => {
    assert.equal(progressSignature([{ name: "t" }]), progressSignature([{ name: "t", input: {} }]));
  });
});

describe("StallTracker", () => {
  it("threshold 0 disables detection", () => {
    const t = new StallTracker(0);
    for (let i = 0; i < 10; i++) assert.equal(t.observe("same").stalled, false);
  });

  it("does not trip while signatures keep changing", () => {
    const t = new StallTracker(2);
    assert.equal(t.observe("a").stalled, false);
    assert.equal(t.observe("b").stalled, false);
    assert.equal(t.observe("a").stalled, false); // non-consecutive repeat is fine
  });

  it("trips with action=feedback after `threshold` consecutive repeats", () => {
    const t = new StallTracker(2);
    t.observe("x"); // first occurrence
    assert.equal(t.observe("x").stalled, false); // repeat 1
    const v = t.observe("x"); // repeat 2 == threshold
    assert.equal(v.stalled, true);
    assert.equal(v.stalled && v.action, "feedback");
  });

  it("escalates to abort on the second strike", () => {
    const t = new StallTracker(1);
    t.observe("x");
    const first = t.observe("x");
    assert.equal(first.stalled && first.action, "feedback");
    // window resets after the strike: needs threshold repeats again
    const second = t.observe("x");
    assert.equal(second.stalled && second.action, "abort");
  });

  it("recovers when progress resumes after a strike", () => {
    const t = new StallTracker(1);
    t.observe("x");
    assert.equal(t.observe("x").stalled, true); // strike 1
    assert.equal(t.observe("y").stalled, false); // progress again
    assert.equal(t.observe("y").stalled, true); // but a NEW stall still aborts (strike 2)
  });

  it("exports actionable feedback text", () => {
    assert.match(STALL_FEEDBACK, /DIFFERENT strategy/);
  });
});
