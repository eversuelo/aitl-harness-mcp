/**
 * Stall detection — verifying the loop's own PROGRESS, not just its termination.
 *
 * An iteration's progress signature is the hash of (the tool calls it made, the
 * workspace state after them). Two consecutive iterations with the same signature
 * mean the model acted identically AND nothing changed on disk — it is spinning.
 * The tracker escalates: first threshold hit injects corrective feedback; a second
 * hit ends the run as `stalled` (a distinct, measurable outcome for the thesis
 * stability metric — it must never masquerade as `done`).
 *
 * Everything here is pure/deterministic except `workspaceDigest`, which shells out
 * to git (best-effort: a non-repo or missing git yields a constant digest, so stall
 * detection degrades to "same tool calls repeated" instead of breaking the run).
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface ToolCallShape {
  name: string;
  input?: Record<string, unknown>;
}

/** Deterministic signature of one iteration's actions + resulting workspace state. */
export function progressSignature(toolCalls: ToolCallShape[], workspace = ""): string {
  const actions = toolCalls.map((c) => ({ name: c.name, input: c.input ?? {} }));
  return createHash("sha256")
    .update(JSON.stringify(actions))
    .update("|")
    .update(workspace)
    .digest("hex");
}

/**
 * Digest of the working tree's current state (staged + unstaged + untracked).
 * Best-effort: outside a git repo (or without git) it returns "" — signatures then
 * compare tool calls only.
 */
export async function workspaceDigest(cwd = process.cwd()): Promise<string> {
  try {
    const { stdout: status } = await execFileP("git", ["-C", cwd, "status", "--porcelain"], {
      maxBuffer: 1024 * 1024,
    });
    const { stdout: diff } = await execFileP("git", ["-C", cwd, "diff", "--stat", "HEAD"], {
      maxBuffer: 1024 * 1024,
    });
    return createHash("sha256").update(status).update("|").update(diff).digest("hex");
  } catch {
    return "";
  }
}

export type StallVerdict =
  | { stalled: false; repeats: number }
  /** `action` escalates: "feedback" on the first strike, "abort" on the second. */
  | { stalled: true; repeats: number; action: "feedback" | "abort" };

/**
 * Tracks consecutive identical progress signatures across loop iterations.
 * `threshold` = how many consecutive repeats (beyond the first occurrence) trip it;
 * 0 disables detection entirely.
 */
export class StallTracker {
  private last: string | null = null;
  private repeats = 0;
  private strikes = 0;

  constructor(private threshold: number) {}

  observe(signature: string): StallVerdict {
    if (this.threshold <= 0) return { stalled: false, repeats: 0 };
    if (signature === this.last) {
      this.repeats += 1;
    } else {
      this.last = signature;
      this.repeats = 0;
    }
    if (this.repeats >= this.threshold) {
      this.strikes += 1;
      this.repeats = 0; // fresh window after each strike so feedback gets a fair chance
      return { stalled: true, repeats: this.threshold, action: this.strikes >= 2 ? "abort" : "feedback" };
    }
    return { stalled: false, repeats: this.repeats };
  }
}

/** Corrective feedback injected on the first stall strike. */
export const STALL_FEEDBACK =
  "You have repeated the same actions for several iterations without changing anything " +
  "in the workspace. You are stuck. Diagnose why the current approach is not working and " +
  "try a DIFFERENT strategy; if the task is impossible with the available tools, say so and stop.";
