/**
 * Bare-ESC interrupt for the chat REPL: while an agent turn runs, one ESC keypress
 * aborts the turn (via AbortController) without killing the REPL.
 *
 * Raw mode is required to see ESC before the terminal cooks it; raw mode also
 * swallows ^C, so 0x03 is re-emitted as SIGINT to keep the existing kill path
 * intact (ADR-0045: ^C must ALWAYS kill the REPL). Arrow/function/alt keys arrive
 * as multi-byte ESC-prefixed sequences in a single data chunk, so a bare ESC is
 * exactly one 0x1b byte.
 */

function asBuffer(chunk: Buffer | string): Buffer {
  return typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk;
}

/** True only for a lone ESC byte — never for ESC-prefixed sequences (arrows, F-keys, alt+key). */
export function isBareEscape(chunk: Buffer | string): boolean {
  const buf = asBuffer(chunk);
  return buf.length === 1 && buf[0] === 0x1b;
}

/** True for a raw ^C byte (ETX), which raw mode swallows instead of raising SIGINT. */
export function isCtrlC(chunk: Buffer | string): boolean {
  const buf = asBuffer(chunk);
  return buf.length === 1 && buf[0] === 0x03;
}

/**
 * Watch stdin for a bare ESC while an agent turn is pending. Returns a cleanup
 * function that detaches the listener and restores the previous stdin state.
 * No-op (still returns a cleanup) when stdin is not a TTY.
 */
export function listenForEscape(onEscape: () => void): () => void {
  const stdin = process.stdin;
  if (!stdin.isTTY) return () => {};
  const wasRaw = stdin.isRaw === true;
  const wasPaused = stdin.isPaused();
  if (!wasRaw) stdin.setRawMode(true);
  stdin.resume();
  const onData = (chunk: Buffer) => {
    if (isBareEscape(chunk)) onEscape();
    else if (isCtrlC(chunk)) process.kill(process.pid, "SIGINT"); // raw mode swallowed it
  };
  stdin.on("data", onData);
  return () => {
    stdin.off("data", onData);
    if (!wasRaw && stdin.isTTY) stdin.setRawMode(false);
    if (wasPaused) stdin.pause();
  };
}
