// deep-equal.ts — structural equality for plain parse-output data.
//
// Built for CanvasNode identity preservation (store.ts): after a re-parse the
// parser emits ALL-NEW node objects even for the ~857 of 860 nodes an edit
// didn't touch. Reference-equality consumers (selectAtom, React.memo, useMemo
// deps) then see "everything changed" and the whole editor re-renders on every
// commit. `deepEqualPlain` is the arbiter that lets the store swap an
// unchanged fresh node for its previous-generation object (identical content ⇒
// identical ref) so per-node subscriptions can skip.
//
// Handles the data shapes that actually occur in parse output: primitives,
// null/undefined, plain objects, arrays, and Set (CanvasNode.hiddenOnVariants).
// NOT a general-purpose isEqual: no Map, Date, RegExp, functions, or cycles —
// parse output contains none of those, and bailing false on an unknown shape
// is the safe direction (worst case: no preservation, today's behavior).

/** Structural equality over plain JSON-ish data (+ Set). Conservative: any
 *  shape it doesn't recognise compares as NOT equal. */
export function deepEqualPlain(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;

  const aIsArr = Array.isArray(a);
  if (aIsArr !== Array.isArray(b)) return false;
  if (aIsArr) {
    const aa = a as unknown[];
    const ba = b as unknown[];
    if (aa.length !== ba.length) return false;
    for (let i = 0; i < aa.length; i++) {
      if (!deepEqualPlain(aa[i], ba[i])) return false;
    }
    return true;
  }

  const aIsSet = a instanceof Set;
  if (aIsSet !== b instanceof Set) return false;
  if (aIsSet) {
    const as = a as Set<unknown>;
    const bs = b as Set<unknown>;
    if (as.size !== bs.size) return false;
    for (const v of as) if (!bs.has(v)) return false; // primitive members (Set<string> in practice)
    return true;
  }

  // Reject exotic objects (Map, Date, RegExp, class instances) — only plain
  // objects are compared field-by-field. Prototype check keeps a class
  // instance from silently comparing equal to a plain object with the same
  // shape.
  const aProto = Object.getPrototypeOf(a);
  const bProto = Object.getPrototypeOf(b);
  if (aProto !== bProto) return false;
  if (aProto !== Object.prototype && aProto !== null) return false;

  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqualPlain(ao[k], bo[k])) return false;
  }
  return true;
}
