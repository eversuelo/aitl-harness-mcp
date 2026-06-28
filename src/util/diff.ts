/**
 * Minimal, dependency-free diffing for the `--diff` flag of `aitl adr/memory history`.
 *
 * - `diffFields` compares two records field by field (scalars/arrays rendered inline).
 * - `diffLines` is a simple LCS line diff for long text fields (context/decision/body).
 */

/** Longest-common-subsequence line diff → unified-ish +/- lines. */
export function diffLines(before: string, after: string): string[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  // LCS length table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(`- ${a[i]}`);
      i++;
    } else {
      out.push(`+ ${b[j]}`);
      j++;
    }
  }
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);
  return out;
}

function render(value: unknown): string {
  if (value === null || value === undefined) return "∅";
  if (Array.isArray(value)) return `[${value.map(String).join(", ")}]`;
  return String(value);
}

const LONG_TEXT = new Set(["context", "decision", "consequences", "body", "description"]);

/**
 * Field-level diff between two snapshots. Short fields render inline (`before → after`);
 * long text fields get a line diff. Returns formatted lines (empty if no changes).
 */
export function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: readonly string[],
): string[] {
  const out: string[] = [];
  for (const f of fields) {
    const bv = before?.[f];
    const av = after?.[f];
    if (JSON.stringify(bv ?? null) === JSON.stringify(av ?? null)) continue;
    if (LONG_TEXT.has(f) && (typeof bv === "string" || typeof av === "string")) {
      out.push(`${f}:`);
      for (const ln of diffLines(String(bv ?? ""), String(av ?? ""))) out.push(`  ${ln}`);
    } else {
      out.push(`${f}: ${render(bv)} → ${render(av)}`);
    }
  }
  return out;
}
