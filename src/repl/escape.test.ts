import assert from "node:assert/strict";
import { test } from "node:test";
import { isBareEscape, isCtrlC } from "./escape.js";

test("isBareEscape matches a lone ESC byte only", () => {
  assert.equal(isBareEscape(Buffer.from([0x1b])), true);
  assert.equal(isBareEscape("\x1b"), true);
  // ESC-prefixed sequences (arrow keys, F-keys, alt+key) must NOT interrupt.
  assert.equal(isBareEscape("\x1b[A"), false); // up arrow
  assert.equal(isBareEscape("\x1bOP"), false); // F1
  assert.equal(isBareEscape("\x1ba"), false); // alt+a
  assert.equal(isBareEscape("a"), false);
  assert.equal(isBareEscape(""), false);
});

test("isCtrlC matches a raw ^C byte only", () => {
  assert.equal(isCtrlC(Buffer.from([0x03])), true);
  assert.equal(isCtrlC("\x03"), true);
  assert.equal(isCtrlC("\x1b"), false);
  assert.equal(isCtrlC("c"), false);
});
