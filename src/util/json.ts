/**
 * Balanced JSON extraction from free-form model output.
 *
 * A greedy regex (`/\[[\s\S]*\]/`) over-matches when the model appends prose containing
 * another closing bracket after the JSON — found live with gemma-4 on LM Studio — so we
 * walk brackets (string- and escape-aware) instead. Factored out of `specs/decompose.ts`
 * so the council adapters (and any future strict-JSON caller) share ONE extractor.
 */

function extractBalanced(text: string, open: "[" | "{", close: "]" | "}", what: string): string {
  const start = text.indexOf(open);
  if (start === -1) throw new Error(`no JSON ${what} found in the answer`);
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced JSON ${what} in the answer`);
}

/** Extract the FIRST balanced JSON array from free-form text. */
export function extractJsonArray(text: string): string {
  return extractBalanced(text, "[", "]", "array");
}

/** Extract the FIRST balanced JSON object from free-form text. */
export function extractJsonObject(text: string): string {
  return extractBalanced(text, "{", "}", "object");
}
