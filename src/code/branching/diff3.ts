// branching/diff3.ts — minimal line-based 3-way merge (Porte 8, merge core).
//
// Merges file text (base/ours/theirs line arrays): disjoint hunks merge
// cleanly (formatting preserved — no AST reprint), overlapping hunks become
// conflict blocks the caller classifies (merge.ts maps them to data-ids and
// matrix kinds). Pure, dependency-free, tested per matrix cell. Small files
// only in practice (page/component sources); LCS is O(n*m) time — capped
// below (oversize files fall back to whole-file conflict, never hang).

import { trace } from '@/shared/debug-trace';

/** Cap: beyond this many lines per side, no LCS — whole-file conflict. */
export const DIFF3_MAX_LINES = 2000;

export interface Diff3Conflict {
  /** 0-based half-open ranges in each version. */
  baseStart: number;
  baseEnd: number;
  oursStart: number;
  oursEnd: number;
  theirsStart: number;
  theirsEnd: number;
}

export type Diff3Chunk =
  | { kind: 'clean'; lines: string[] }
  | ({ kind: 'conflict' } & Diff3Conflict);

interface Op {
  kind: 'same' | 'del' | 'ins';
  line: string;
  index: number;
}

/** LCS table (lengths only) + backtrack into an edit script. */
function diffOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const len: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      len[i][j] = a[i] === b[j] ? len[i + 1][j + 1] + 1 : Math.max(len[i + 1][j], len[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'same', line: a[i], index: i });
      i++;
      j++;
    } else if (len[i + 1][j] >= len[i][j + 1]) {
      ops.push({ kind: 'del', line: a[i], index: i });
      i++;
    } else {
      ops.push({ kind: 'ins', line: b[j], index: j });
      j++;
    }
  }
  while (i < n) {
    ops.push({ kind: 'del', line: a[i], index: i });
    i++;
  }
  while (j < m) {
    ops.push({ kind: 'ins', line: b[j], index: j });
    j++;
  }
  return ops;
}

interface Hunk {
  baseStart: number;
  baseEnd: number;
  lines: string[];
}

/** Collapse an edit script into changed hunks (base ranges + new lines). */
function hunks(ops: Op[]): Hunk[] {
  const out: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const op of ops) {
    if (op.kind === 'same') {
      cur = null;
      continue;
    }
    if (!cur) {
      cur = { baseStart: op.kind === 'del' ? op.index : op.index, baseEnd: op.index, lines: [] };
      // For pure insertions, anchor at the base position between lines.
      if (op.kind === 'ins') {
        cur.baseStart = op.index;
        cur.baseEnd = op.index;
      }
      out.push(cur);
    }
    if (op.kind === 'del') cur.baseEnd = op.index + 1;
    else cur.lines.push(op.line);
  }
  return out;
}

/**
 * 3-way merge. Returns clean lines + conflict blocks. Overlapping hunks
 * conflict (identical changes on both sides merge silently); disjoint hunks
 * apply in base order. Overlap is inclusive on both ends so a zero-width
 * insertion at a change boundary (or at another insertion anchor) conflicts
 * instead of interleaving silently.
 */
export function diff3Merge(base: string[], ours: string[], theirs: string[]): Diff3Chunk[] {
  if (base.length > DIFF3_MAX_LINES || ours.length > DIFF3_MAX_LINES || theirs.length > DIFF3_MAX_LINES) {
    trace.action('branching-diff3:oversize-fallback', { base: base.length, ours: ours.length, theirs: theirs.length });
    return [
      {
        kind: 'conflict',
        baseStart: 0,
        baseEnd: base.length,
        oursStart: 0,
        oursEnd: ours.length,
        theirsStart: 0,
        theirsEnd: theirs.length,
      },
    ];
  }
  const ho = hunks(diffOps(base, ours));
  const ht = hunks(diffOps(base, theirs));
  const chunks: Diff3Chunk[] = [];
  // Touching at a single point ([3,4) vs [4,5)) is disjoint — only a
  // zero-width insertion landing ON a change (or another insertion at the
  // same anchor) overlaps. Adjacent edits must never conflict.
  const overlaps = (x: Hunk, y: Hunk): boolean => {
    const start = Math.max(x.baseStart, y.baseStart);
    const end = Math.min(x.baseEnd, y.baseEnd);
    if (start < end) return true;
    if (start > end) return false;
    return x.baseStart === x.baseEnd || y.baseStart === y.baseEnd;
  };
  const sameLines = (x: string[], y: string[]): boolean => x.length === y.length && x.every((l, i) => l === y[i]);

  let bi = 0;
  let oi = 0;
  let ti = 0;
  let a = 0;
  let b = 0;
  // Emit clean base lines up to (not including) base index `to`.
  const emitBase = (to: number): void => {
    while (bi < to && bi < base.length) {
      chunks.push({ kind: 'clean', lines: [base[bi]] });
      bi++;
      oi++;
      ti++;
    }
  };

  while (a < ho.length || b < ht.length) {
    const h1 = a < ho.length ? ho[a] : null;
    const h2 = b < ht.length ? ht[b] : null;
    if (h1 && h2 && overlaps(h1, h2)) {
      emitBase(Math.min(h1.baseStart, h2.baseStart));
      const same =
        h1.baseStart === h2.baseStart && h1.baseEnd === h2.baseEnd && sameLines(h1.lines, h2.lines);
      if (same) {
        chunks.push({ kind: 'clean', lines: h1.lines });
      } else {
        chunks.push({
          kind: 'conflict',
          baseStart: Math.min(h1.baseStart, h2.baseStart),
          baseEnd: Math.max(h1.baseEnd, h2.baseEnd),
          oursStart: oi,
          oursEnd: oi + h1.lines.length,
          theirsStart: ti,
          theirsEnd: ti + h2.lines.length,
        });
      }
      // Advance past both hunks: base to the max end; each side past its own
      // hunk lines plus any base lines the other side consumed.
      const baseEnd = Math.max(h1.baseEnd, h2.baseEnd);
      oi += h1.lines.length + (baseEnd - h1.baseEnd);
      ti += h2.lines.length + (baseEnd - h2.baseEnd);
      bi = baseEnd;
      a++;
      b++;
    } else {
      // Disjoint: take the earliest hunk (insertion anchor order breaks ties).
      const h = h1 !== null && (h2 === null || h1.baseStart < h2.baseStart || (h1.baseStart === h2.baseStart && h1.baseEnd < h2.baseEnd)) ? h1! : h2!;
      const takeOurs = h === h1;
      emitBase(h.baseStart);
      chunks.push({ kind: 'clean', lines: h.lines });
      if (takeOurs) {
        oi += h.lines.length;
        ti += h.baseEnd - h.baseStart;
        a++;
      } else {
        ti += h.lines.length;
        oi += h.baseEnd - h.baseStart;
        b++;
      }
      bi = h.baseEnd;
    }
  }
  emitBase(base.length);
  return chunks;
}
