// src/ai/agent/source-edits.ts — anchored find/replace edits on a source file.
//
// Why this exists: the only code-writing agent tool was apply_file_edit, which
// takes the COMPLETE file. A 3,000-line page is ~40k tokens — more than a model
// can emit in one tool call — so the rewrite arrived cut off and the gate
// rejected it (SYNTAX_ERROR / CANVAS_CONFIG_DESTROYED), or, worse, the model
// "summarised" the parts it never meant to touch (agent report 2026-10-15).
//
// Anchored edits invert that: the payload is the changed hunks only, and every
// byte the model never mentions is guaranteed untouched because it is never
// re-emitted. The result still goes through the SAME oracle gate as a rewrite.
//
// Uniqueness is the safety property: an anchor that matches twice is
// ambiguous, and picking one silently would corrupt the other site. Such an
// edit is REJECTED with the line numbers of every match, so the caller can
// extend the anchor. The whole batch applies to a local string; nothing is
// written unless every edit landed.
//
// Same contract as the MCP proxy's `revyme_edit_file` (ai-generator
// apply-edits.ts), plus line numbers and near-miss hints in the errors.

export interface SourceEdit {
  /** Exact text to find — must appear exactly once unless `replace_all`. */
  old_text: string;
  /** Replacement text. Empty string deletes the matched span. */
  new_text: string;
  /** Replace every occurrence instead of requiring a unique match. */
  replace_all?: boolean;
}

export type SourceEditsResult =
  | {
      ok: true;
      code: string;
      /** Replacements per edit, in input order. */
      counts: number[];
      /** 1-based line span of the changed region in the NEW file. */
      changed: { from_line: number; to_line: number };
    }
  | { ok: false; error: string };

/** Short, unambiguous quote of an anchor for error messages. */
function preview(s: string, max = 80): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function lineAt(code: string, index: number): number {
  let n = 1;
  for (let i = code.indexOf('\n'); i !== -1 && i < index; i = code.indexOf('\n', i + 1)) n++;
  return n;
}

function matchIndexes(haystack: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

/**
 * Where the anchor WOULD match if whitespace were ignored — the usual cause of
 * a miss (re-indented copy, tabs vs spaces, a wrapped line). Returns the
 * 1-based line of the first such match, or null.
 */
function whitespaceInsensitiveLine(code: string, needle: string): number | null {
  const tokens = needle.trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (tokens.length === 0 || tokens.join('').length < 8) return null;
  try {
    const m = new RegExp(tokens.join('\\s*')).exec(code);
    return m ? lineAt(code, m.index) : null;
  } catch {
    return null;
  }
}

/** Lines where the anchor's first non-empty line occurs — a pointer for a re-read. */
function firstLineHits(code: string, needle: string): number[] {
  const first = needle.split('\n').map((l) => l.trim()).find((l) => l.length >= 6);
  if (!first) return [];
  const lines = code.split('\n');
  const hits: number[] = [];
  for (let i = 0; i < lines.length && hits.length < 5; i++) if (lines[i].includes(first)) hits.push(i + 1);
  return hits;
}

/**
 * Apply `edits` IN ORDER to `code`. Sequential on purpose: a later edit may
 * anchor on text an earlier one produced. Never a partial result — the first
 * failing edit fails the batch with a precise reason.
 */
export function applySourceEdits(code: string, edits: readonly SourceEdit[]): SourceEditsResult {
  if (edits.length === 0) return { ok: false, error: 'No edits supplied — send at least one { old_text, new_text }.' };

  let out = code;
  const counts: number[] = [];
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const label = `edit ${i + 1}/${edits.length}`;
    if (edit.old_text === '') {
      return { ok: false, error: `${label}: old_text is empty. Anchor the edit on real text from the file (read_source it first).` };
    }
    if (edit.old_text === edit.new_text) {
      return { ok: false, error: `${label}: old_text and new_text are identical — nothing to do.` };
    }
    const at = matchIndexes(out, edit.old_text);
    if (at.length === 0) {
      const near = whitespaceInsensitiveLine(out, edit.old_text);
      const hits = near === null ? firstLineHits(out, edit.old_text) : [];
      const hint = near !== null
        ? ` It matches at line ${near} if whitespace is ignored — read_source that line range and copy the text EXACTLY (indentation, line breaks, quotes).`
        : hits.length > 0
          ? ` Its first line appears at line ${hits.join(', ')} — read_source around there and copy the anchor exactly.`
          : ' Re-read the file with read_source (query: a distinctive word from the anchor finds the line).';
      const order = i > 0 ? ' Edits apply IN ORDER — an earlier edit in this call may have already changed this text.' : '';
      return { ok: false, error: `${label}: old_text not found: "${preview(edit.old_text)}".${hint}${order}` };
    }
    if (at.length > 1 && !edit.replace_all) {
      const lines = at.slice(0, 10).map((idx) => lineAt(out, idx));
      return {
        ok: false,
        error: `${label}: old_text matches ${at.length} places (lines ${lines.join(', ')}${at.length > 10 ? ', …' : ''}): "${preview(edit.old_text)}". Extend the anchor with surrounding lines so it is unique, or pass replace_all: true if every occurrence should change.`,
      };
    }
    // Splice by INDEX, never `String.replace(str, str)` — that still expands
    // `$&`, `$$`, `` $` ``, `$'` in the REPLACEMENT, so a new_text carrying them
    // (easy in JSX/template literals) would be silently mangled.
    out = edit.replace_all
      ? out.split(edit.old_text).join(edit.new_text)
      : out.slice(0, at[0]) + edit.new_text + out.slice(at[0] + edit.old_text.length);
    counts.push(at.length);
  }
  if (out === code) return { ok: false, error: 'The edits produced no change to the file.' };

  // The changed region: common prefix / suffix between before and after.
  let p = 0;
  while (p < code.length && p < out.length && code[p] === out[p]) p++;
  let s = 0;
  while (s < code.length - p && s < out.length - p && code[code.length - 1 - s] === out[out.length - 1 - s]) s++;
  const from = lineAt(out, p);
  const to = Math.max(from, lineAt(out, Math.max(p, out.length - s - 1)));
  return { ok: true, code: out, counts, changed: { from_line: from, to_line: to } };
}
