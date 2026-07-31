// sandbox-dom-utils.ts — Shared node-id element lookup for the sandbox side
// (9.4e). Consolidates the ~29 inline
// `querySelector(`[data-node-id="${vpPrefix}${nodeId}"]`)` constructions in
// bridge-sandbox.ts and the host modules into one helper.
//
// BEHAVIOR DECISION (logged per plan): the selector value is passed through
// `cssEscape` uniformly — promoted from text-edit-host's local copy. Node ids
// are generated safe (no CSS-special characters), so behavior is identical
// for real ids; the escape only hardens lookups against exotic ids.

/** Minimal CSS attribute selector escape — handles the characters likely to
 *  appear in node ids (mostly hyphens and dots). querySelector treats `.` as
 *  a class delimiter unless escaped. */
export function cssEscape(value: string): string {
  return value.replace(/[\\"'#.[\]:()/<>?@!,&=]/g, (m) => `\\${m}`);
}

/** Exact-match attribute selector for a node's `data-node-id`. */
export function nodeIdSelector(vpPrefix: string, nodeId: string): string {
  return `[data-node-id="${cssEscape(`${vpPrefix}${nodeId}`)}"]`;
}

/** Find the element rendering `nodeId` under `vpPrefix` inside `root`. */
export function findElByNodeId<T extends Element = HTMLElement>(
  root: ParentNode,
  vpPrefix: string,
  nodeId: string,
): T | null {
  return root.querySelector(nodeIdSelector(vpPrefix, nodeId)) as T | null;
}

/** All elements rendering `nodeId` under `vpPrefix` inside `root` (a node can
 *  paint more than once — e.g. `.map()` ghosts sharing the template's id). */
export function findAllByNodeId<T extends Element = HTMLElement>(
  root: ParentNode,
  vpPrefix: string,
  nodeId: string,
): T[] {
  return Array.from(root.querySelectorAll(nodeIdSelector(vpPrefix, nodeId))) as T[];
}
