// project/file-diff.ts — per-file node diffs between two ProjectFS snapshots.
//
// Ported from the agent fork's `ai/agent/checkpoint.ts` (2026-09-18) and moved
// DOWN a layer: this is a pure function over two file maps, and both the
// branching engine and the agent's turn checkpoint need it. Leaving it in
// `ai/` forced `code/branching` -> `ai/agent` imports, which inverts the
// layering (branching is a builder feature; it must not depend on the agent).
//
// Semantics: compare the PARSED node maps, not the raw text, so a
// reformat-only rewrite is not reported as a change. A side that fails to
// parse yields empty id sets — ids we could not verify are never guessed.

import { partsForFile, type ChangePart } from './change-parts';
import { parseJSXToNodes, type CanvasNode } from '@/code/parsing/parser';

export interface TurnFileChange {
  path: string;
  addedIds: string[];
  removedIds: string[];
  changedIds: string[];
  /** What changed in a file that is NOT made of layers — styles in
   *  globals.css, a collection's items and fields, translated strings. Absent
   *  for pages and components, whose unit is the id sets above. */
  parts?: ChangePart[];
}

/** Per-file id diffs between two ProjectFS snapshots. Deterministic order. */
export function diffTurnChanges(
  before: Map<string, string>,
  after: Map<string, string>,
): TurnFileChange[] {
  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  const changes: TurnFileChange[] = [];
  for (const path of [...paths].sort()) {
    if (before.get(path) === after.get(path)) continue;
    const change = diffFile(path, before.get(path), after.get(path));
    const parts = partsForFile(path, before.get(path), after.get(path));
    changes.push(parts ? { ...change, parts } : change);
  }
  return changes;
}

function diffFile(
  path: string,
  beforeCode: string | undefined,
  afterCode: string | undefined,
): TurnFileChange {
  const beforeNodes = parseNodes(beforeCode);
  const afterNodes = parseNodes(afterCode);
  if (beforeNodes === null || afterNodes === null) {
    // A side failed to parse: report the file with empty id sets rather than
    // guessing ids we could not verify.
    return { path, addedIds: [], removedIds: [], changedIds: [] };
  }
  const addedIds: string[] = [];
  const removedIds: string[] = [];
  const changedIds: string[] = [];
  for (const [id, node] of afterNodes) {
    const prev = beforeNodes.get(id);
    if (!prev) addedIds.push(id);
    else if (projection(prev) !== projection(node)) changedIds.push(id);
  }
  for (const id of beforeNodes.keys()) {
    if (!afterNodes.has(id)) removedIds.push(id);
  }
  return { path, addedIds, removedIds, changedIds };
}

function parseNodes(code: string | undefined): Map<string, CanvasNode> | null {
  if (code === undefined) return new Map();
  try {
    const nodes = parseJSXToNodes(code);
    // parseJSXToNodes swallows Babel errors and returns an empty map ("user is
    // typing"); treat an empty parse of NON-EMPTY code as a parse failure.
    return nodes.size === 0 && code.trim().length > 0 ? null : nodes;
  } catch {
    return null;
  }
}

/**
 * Comparable projection of a node.
 *
 * DERIVED from the node's own keys, deliberately — the fork hand-listed 11
 * fields, and `CanvasNode` has 29. Everything it omitted (`textOverrides`,
 * `graphicMarkup`, `order`, `componentFile`, `motionVariants`, …) silently
 * failed to register as a change, so a revert could miss it and the branch
 * diff could call a genuinely-edited node clean. Every field is real authored
 * state; none is derived or volatile, so "all of them except the key" is the
 * correct rule and it cannot go stale when a field is added.
 */
function projection(node: CanvasNode): string {
  const out: Record<string, unknown> = {};
  // `id` is the map key — identical by construction, and including it would
  // only add noise. Sorted so key order never affects the comparison.
  for (const key of Object.keys(node).sort()) {
    if (key === 'id') continue;
    const v = (node as unknown as Record<string, unknown>)[key];
    if (v === undefined) continue;   // absent and undefined compare equal
    out[key] = v;
  }
  return JSON.stringify(out);
}
