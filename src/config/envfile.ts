/**
 * Minimal-diff `.env` editor (P3.5) — mirror config changes into a project's dotenv.
 *
 * `applyConfigUpdates` persists to `~/.aitl/config.json` AND to the project `.env`
 * so both a globally-installed CLI and a repo-local run see the same values. This
 * module owns the `.env` side: it edits the file surgically, preserving comments,
 * blank lines, ordering and any lines it does not understand.
 *
 * Semantics per key (value `string`):
 *   - every active `KEY=...` line is replaced in place with `KEY=value`;
 *   - else the FIRST commented `# KEY=...` line is uncommented and set;
 *   - else `KEY=value` is appended at the end of the file.
 * Per key (value `null` = unset):
 *   - every active `KEY=...` line becomes `# KEY=` (the old value is dropped on
 *     purpose so stale secrets don't linger in comments);
 *   - absent/already-commented keys are left untouched (no-op).
 *
 * No import of `../config.js` (values may feed it) and no logging of values —
 * callers pass secrets through here.
 */

import { promises as fs } from "node:fs";
import { dirname } from "node:path";

function escapeKey(key: string): string {
  return key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Active assignment line for `key` (leading whitespace tolerated). */
function activeRe(key: string): RegExp {
  return new RegExp(`^\\s*${escapeKey(key)}\\s*=`);
}

/** Commented-out assignment line for `key` (e.g. `# KEY=...` or `#KEY=`). */
function commentedRe(key: string): RegExp {
  return new RegExp(`^\\s*#\\s*${escapeKey(key)}\\s*=`);
}

/**
 * Apply `updates` to the dotenv file at `path` (created when missing), preserving
 * everything not addressed by an update. `null` comments the key out; a string
 * sets it (replacing active lines or uncommenting a `# KEY=...` line).
 */
export async function updateEnvFile(path: string, updates: Record<string, string | null>): Promise<void> {
  const existing = await fs.readFile(path, "utf-8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });

  const content = existing ?? "";
  const lines = content.length ? content.split(/\r?\n/) : [];
  // A trailing newline yields one final "" element; drop it and re-add on write.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  for (const [key, value] of Object.entries(updates)) {
    const active = activeRe(key);
    const commented = commentedRe(key);

    if (value === null) {
      for (let i = 0; i < lines.length; i++) {
        if (active.test(lines[i])) lines[i] = `# ${key}=`;
      }
      continue;
    }

    const next = `${key}=${value}`;
    let replaced = false;
    for (let i = 0; i < lines.length; i++) {
      if (active.test(lines[i])) {
        lines[i] = next;
        replaced = true;
      }
    }
    if (replaced) continue;

    const commentIdx = lines.findIndex((l) => commented.test(l));
    if (commentIdx !== -1) {
      lines[commentIdx] = next;
    } else {
      lines.push(next);
    }
  }

  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, lines.length ? `${lines.join("\n")}\n` : "", "utf-8");
}
