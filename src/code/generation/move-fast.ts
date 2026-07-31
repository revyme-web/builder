// move-fast.ts — STRING-SPLICE fast path for moveNodeInCode's common case:
// reparenting a plain element INTO another plain element (both already in the
// tree). The AST path (parseJSX → mutate → generate the WHOLE file) costs a
// full babel round-trip on the page string — ~100ms + heavy GC on a 470KB
// import (the "reparent mouseup is slow" find). Moving a node is, textually,
// just: cut its JSX span out, splice it into the target parent's children.
//
// This handles ONLY the safe common case and returns null (→ AST fallback) for
// anything that needs real AST work: exit-to-canvas (newParentId null/root),
// wrapped nodes (`{cond && <el/>}`, ternaries, `.map()` bodies, AnimatePresence),
// self-closing / map-holding targets, duplicate data-ids, or a node whose
// subtree carries variant/responsive-text wiring the AST path rewrites.
//
// Mirrors updateNodeInCode's fast-path-then-AST-fallback pattern.

import { findJSXDataIdIndex, findTagClose, findMatchingCloseTagIndex } from './generator-utils';

const isWs = (c: string): boolean => c === ' ' || c === '\n' || c === '\t' || c === '\r';

export interface ElementSpan {
  tagStart: number;   // index of the element's `<`
  openGt: number;     // index of the opening tag's `>`
  elemEnd: number;    // index one-past the element's end (`/>` or `</tag>`)
  tagName: string;
}

/** Locate a plain JSX element by data-id and return its full text span, or null
 *  if it can't be resolved as a plain child (wrapped, duplicate id, malformed). */
export function extractPlainElementSpan(code: string, nodeId: string): ElementSpan | null {
  // Duplicate data-id (replica / stray) → the AST path resolves the canonical
  // one; a string splice can't tell them apart.
  const first = code.indexOf(`data-id="${nodeId}"`);
  if (first === -1 || first !== code.lastIndexOf(`data-id="${nodeId}"`)) return null;

  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return null;

  let tagStart = idIdx;
  while (tagStart > 0 && code[tagStart] !== '<') tagStart--;
  if (code[tagStart] !== '<') return null;

  const tm = /^<([A-Za-z][\w.]*)/.exec(code.slice(tagStart, tagStart + 48));
  if (!tm) return null;
  const tagName = tm[1];

  const openGt = findTagClose(code, tagStart + 1);
  if (openGt === -1) return null;

  let elemEnd: number;
  if (code[openGt - 1] === '/') {
    elemEnd = openGt + 1; // self-closing `<tag … />`
  } else {
    const closeRel = findMatchingCloseTagIndex(code, tagName, openGt + 1);
    if (closeRel === -1) return null;
    elemEnd = closeRel + `</${tagName}>`.length;
  }

  return { tagStart, openGt, elemEnd, tagName };
}

/** True when the element at `span` sits directly in a children list (preceded
 *  by `>` and followed by `<`, ignoring whitespace) — i.e. NOT inside a
 *  `{cond && …}` / ternary / `.map(() => …)` wrapper the AST path must unwind. */
export function isPlainChildContext(code: string, span: ElementSpan): boolean {
  let p = span.tagStart - 1;
  while (p >= 0 && isWs(code[p])) p--;
  if (code[p] !== '>') return false;
  let q = span.elemEnd;
  while (q < code.length && isWs(code[q])) q++;
  return code[q] === '<';
}

/** Byte offsets (relative to `code`) where each DIRECT JSX child of the region
 *  [start, end) begins — element children (`<tag`) and expression-container
 *  children (`{…}`), in source order. Returns null if the region can't be
 *  cleanly walked (bail to AST). */
export function directChildStarts(code: string, start: number, end: number): number[] | null {
  const starts: number[] = [];
  let i = start;
  while (i < end) {
    while (i < end && isWs(code[i])) i++;
    if (i >= end) break;
    const ch = code[i];
    if (ch === '<') {
      if (code[i + 1] === '/') break; // hit the parent's own close tag
      const tm = /^<([A-Za-z][\w.]*)/.exec(code.slice(i, i + 48));
      if (!tm) return null;
      starts.push(i);
      const gt = findTagClose(code, i + 1);
      if (gt === -1 || gt >= end) return null;
      if (code[gt - 1] === '/') { i = gt + 1; continue; }
      const closeRel = findMatchingCloseTagIndex(code, tm[1], gt + 1);
      if (closeRel === -1 || closeRel >= end) return null;
      i = closeRel + `</${tm[1]}>`.length;
    } else if (ch === '{') {
      starts.push(i);
      // Skip a balanced `{ … }` (string-aware).
      let depth = 1; let inStr: string | null = null; let j = i + 1;
      for (; j < end; j++) {
        const c = code[j];
        if (inStr) { if (c === inStr) inStr = null; continue; }
        if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { j++; break; } }
      }
      if (depth !== 0) return null;
      i = j;
    } else {
      // Bare text between elements — not a slot; skip to the next `<` or `{`.
      const nextEl = code.indexOf('<', i);
      const nextEx = code.indexOf('{', i);
      let next = end;
      if (nextEl !== -1) next = Math.min(next, nextEl);
      if (nextEx !== -1) next = Math.min(next, nextEx);
      if (next <= i) return null;
      i = next;
    }
  }
  return starts;
}

/**
 * String-splice reparent: move the element `nodeId` INTO `newParentId` at
 * `insertIndex` (append when null). Returns the new code, or null to signal
 * the caller should fall back to the AST path.
 */
export function moveNodeIntoParentFast(
  code: string,
  nodeId: string,
  newParentId: string,
  insertIndex: number | null | undefined,
): string | null {
  const span = extractPlainElementSpan(code, nodeId);
  if (!span) return null;
  if (!isPlainChildContext(code, span)) return null;
  if (nodeId === newParentId) return null;

  // Strip `data-canvas-node="true"` from the MOVED element's opening tag only
  // (moving into a parent makes it a flow/child, not a floating canvas node).
  // Descendants keep theirs — a nested canvas node is impossible, but be exact.
  const openText = code.slice(span.tagStart, span.openGt + 1);
  const cleanedOpen = openText.replace(/\s+data-canvas-node=(?:"true"|'true'|\{true\})/g, '');
  let movedText = cleanedOpen + code.slice(span.openGt + 1, span.elemEnd);
  movedText = movedText.trim();

  // Cut the source span PLUS the whitespace between it and its previous
  // sibling/parent-open (keeps that `>` — see isPlainChildContext).
  let cutStart = span.tagStart - 1;
  while (cutStart >= 0 && isWs(code[cutStart])) cutStart--;
  cutStart += 1; // first whitespace char after the preceding `>`
  const without = code.slice(0, cutStart) + code.slice(span.elemEnd);

  // Locate the target parent in the CUT string (indices shifted).
  const pFirst = without.indexOf(`data-id="${newParentId}"`);
  if (pFirst === -1 || pFirst !== without.lastIndexOf(`data-id="${newParentId}"`)) return null;
  const pIdIdx = findJSXDataIdIndex(without, newParentId);
  if (pIdIdx === -1) return null;
  let pTagStart = pIdIdx;
  while (pTagStart > 0 && without[pTagStart] !== '<') pTagStart--;
  const pTm = /^<([A-Za-z][\w.]*)/.exec(without.slice(pTagStart, pTagStart + 48));
  if (!pTm) return null;
  const pOpenGt = findTagClose(without, pTagStart + 1);
  if (pOpenGt === -1) return null;
  if (without[pOpenGt - 1] === '/') return null; // self-closing target → AST (ensureParentCanHoldChildren)
  const pCloseRel = findMatchingCloseTagIndex(without, pTm[1], pOpenGt + 1);
  if (pCloseRel === -1) return null;

  const childrenStart = pOpenGt + 1;
  const childrenEnd = pCloseRel;
  const childrenText = without.slice(childrenStart, childrenEnd);
  // Empty-map refill (`=> null` collection list) is a special AST case.
  if (childrenText.includes('.map(')) return null;

  let insertAt: number;
  if (insertIndex == null || insertIndex < 0) {
    insertAt = childrenEnd; // append before `</parent>`
  } else {
    const starts = directChildStarts(without, childrenStart, childrenEnd);
    if (starts === null) return null;
    insertAt = insertIndex >= starts.length ? childrenEnd : starts[insertIndex];
  }

  const snippet = `\n    ${movedText}\n  `;
  return without.slice(0, insertAt) + snippet + without.slice(insertAt);
}
