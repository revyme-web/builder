// cursor-parser.ts — Detect withCursor() spread calls in JSX.
//
// The component-cursor system stores its config inline as a JSX spread:
//   <button {...withCursor(Pointer, { mode: 'follow', transition: { ... } })}>
//
// This parser locates each call, attributes it to the enclosing element's
// data-id, and returns a structured config the editor can render. Web cursor
// (CSS `cursor` property) is parsed via the normal style pipeline — nothing
// to do here for that flavor.
//
// Pairs with src/code/generation/cursor-gen.ts.

import { trace } from '@/shared/debug-trace';

export type CursorMode = 'follow' | 'replace';
export type CursorSide = 'top' | 'bottom' | 'left' | 'right';
export type CursorAlign = 'start' | 'center' | 'end';

export interface CursorTransition {
  type?: 'spring' | 'tween' | 'instant';
  stiffness?: number;
  damping?: number;
  mass?: number;
  duration?: number;
  ease?: string;
}

interface ComponentCursorConfig {
  /** Local identifier name as used in the call: `withCursor(Pointer, ...)` → `Pointer`.
   *  May be a PascalCase imported component (`Pointer`) OR a camelCase
   *  destructured prop (`myCursor`) on a component master — the latter is
   *  the "cursor-as-variable" case where the concrete component is supplied
   *  by the page-level instance. `isVariable` flags which one it is. */
  componentName: string;
  /** True when `componentName` is a lowercase-initial identifier — i.e. a
   *  prop variable rather than an imported component. The cursor tool renders
   *  a purple bound-variable pill instead of the normal component summary. */
  isVariable?: boolean;
  variant?: string;
  mode?: CursorMode;
  /** Anchor side relative to the mouse (Follow mode only). */
  side?: CursorSide;
  /** Alignment along the perpendicular axis (Follow mode only). */
  align?: CursorAlign;
  offsetX?: number;
  offsetY?: number;
  transition?: CursorTransition;
  /** Wrapper width/height (numbers = px). Useful for code components that fill their parent. */
  width?: number | string;
  height?: number | string;
  /** Wrap mount/unmount in AnimatePresence (fade+scale). Defaults to false. */
  enterExit?: boolean;
  /** Source byte offsets — generator uses these for in-place edits. */
  callStart: number;
  callEnd: number;
}

export interface ComponentCursorCall extends ComponentCursorConfig {
  /** data-id of the element this cursor is attached to. */
  nodeId: string;
}

/**
 * Find every `{...withCursor(<Component>, { ... })}` spread in the file and
 * attribute each to the data-id of the element it belongs to.
 */
export function parseComponentCursorCalls(code: string): ComponentCursorCall[] {
  const out: ComponentCursorCall[] = [];
  // Match: {...withCursor(Identifier, {...})}
  // The options object can contain nested objects, so we balance braces.
  // The first arg can be a PascalCase imported component (`Pointer`) OR a
  // camelCase destructured prop (`myCursor`) for the cursor-as-variable
  // case — so the identifier pattern allows a lowercase initial too. The
  // `isVariable` flag downstream is derived from the leading char.
  const startRegex = /\{\.\.\.withCursor\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*\{/g;
  let m: RegExpExecArray | null;

  while ((m = startRegex.exec(code)) !== null) {
    const componentName = m[1];
    // Lowercase-initial identifier → a prop variable, not an imported
    // component. PascalCase → imported component (the original behaviour).
    const isVariable = /^[a-z_]/.test(componentName);
    const optsObjStart = m.index + m[0].length - 1; // points at the `{`
    const optsObjEnd = findMatchingBrace(code, optsObjStart);
    if (optsObjEnd < 0) continue;

    // After the closing brace we expect `)}` (call close + spread close).
    const afterOpts = code.slice(optsObjEnd + 1).match(/^\s*\)\s*\}/);
    if (!afterOpts) continue;
    const callEnd = optsObjEnd + 1 + afterOpts[0].length;

    const optsSrc = code.slice(optsObjStart, optsObjEnd + 1);
    const config = parseOptsObject(optsSrc);
    if (!config) continue;

    // Attribute to the nearest preceding data-id in the same element opening tag.
    const nodeId = findEnclosingDataId(code, m.index);
    if (!nodeId) continue;

    out.push({
      nodeId,
      componentName,
      isVariable,
      ...config,
      callStart: m.index,
      callEnd,
    });
  }

  trace.fn('cursor-parser:parseComponentCursorCalls', { count: out.length });
  return out;
}

/** Find the cursor config attached to a specific node, or null. */
export function getComponentCursorForNode(
  code: string,
  nodeId: string,
): ComponentCursorCall | null {
  const all = parseComponentCursorCalls(code);
  return all.find((c) => c.nodeId === nodeId) ?? null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Given an index pointing at `{`, return the index of its matching `}`.
 * Brace-aware (skips strings/template literals).
 */
function findMatchingBrace(code: string, openIdx: number): number {
  if (code[openIdx] !== '{') return -1;
  let depth = 0;
  let i = openIdx;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(code, i);
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function skipString(code: string, startIdx: number): number {
  const quote = code[startIdx];
  let i = startIdx + 1;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === quote) return i + 1;
    i++;
  }
  return code.length;
}

/**
 * Walk backwards from `attrStart` (the position of the `{...withCursor(...)`)
 * to find the nearest `data-id="…"` inside the same opening tag (between the
 * last `<` and the next `>`). Mirrors the pattern used in overlay-parser and
 * project-parser's findEnclosingDataId.
 */
function findEnclosingDataId(code: string, attrStart: number): string | null {
  // Walk back to the opening `<` of the enclosing tag.
  let i = attrStart;
  while (i > 0 && code[i] !== '<') i--;
  if (code[i] !== '<') return null;
  const tagSlice = code.slice(i, attrStart);
  const matches = tagSlice.match(/data-id="([^"]+)"/g);
  if (!matches || matches.length === 0) return null;
  const last = matches[matches.length - 1].match(/data-id="([^"]+)"/);
  return last ? last[1] : null;
}

/**
 * Parse a JS-ish options object literal (the `{ ... }` second argument to
 * withCursor). Handles nested `transition: { ... }` plus all the scalar
 * fields we know about. Unknown fields are ignored.
 *
 * Not full-blown AST — this object is small (<10 fields, one nested level)
 * and the generator writes it back deterministically, so a regex pass is
 * enough and avoids dragging in babel for parsing.
 */
function parseOptsObject(src: string): {
  variant?: string;
  mode?: CursorMode;
  side?: CursorSide;
  align?: CursorAlign;
  offsetX?: number;
  offsetY?: number;
  transition?: CursorTransition;
  width?: number | string;
  height?: number | string;
  enterExit?: boolean;
} | null {
  const inner = src.slice(1, -1); // strip { }
  const result: ReturnType<typeof parseOptsObject> = {};

  // Pull out transition: { ... } block first (nested, brace-aware).
  const transStart = inner.search(/\btransition\s*:\s*\{/);
  let withoutTransition = inner;
  if (transStart >= 0) {
    const braceIdx = inner.indexOf('{', transStart);
    const braceEnd = findMatchingBrace(inner, braceIdx);
    if (braceEnd > braceIdx) {
      const transSrc = inner.slice(braceIdx, braceEnd + 1);
      result!.transition = parseTransitionObj(transSrc);
      // Strip the transition slice (plus its key) so the scalar pass below
      // doesn't re-encounter the inner braces.
      withoutTransition = inner.slice(0, transStart) + inner.slice(braceEnd + 1);
    }
  }

  // Booleans: `key: true` / `key: false`. Run before the scalar regex (which
  // wouldn't match `true`/`false` anyway, but kept explicit for clarity).
  const boolRegex = /(\w+)\s*:\s*(true|false)\b/g;
  let bm: RegExpExecArray | null;
  while ((bm = boolRegex.exec(withoutTransition)) !== null) {
    if (bm[1] === 'enterExit') result!.enterExit = bm[2] === 'true';
  }

  // Scalars: capture `key: '...'` / `key: "..."` / `key: <number>`.
  // sm[2]/sm[3] = string match (quoted), sm[4] = numeric match.
  const scalarRegex = /(\w+)\s*:\s*(?:'([^']*)'|"([^"]*)"|(-?\d+(?:\.\d+)?))/g;
  let sm: RegExpExecArray | null;
  while ((sm = scalarRegex.exec(withoutTransition)) !== null) {
    const key = sm[1];
    const stringVal = sm[2] ?? sm[3];
    const numVal = sm[4];
    const val = stringVal ?? numVal;
    if (key === 'variant') result!.variant = val;
    else if (key === 'mode' && (val === 'follow' || val === 'replace')) result!.mode = val;
    else if (key === 'side' && (val === 'top' || val === 'bottom' || val === 'left' || val === 'right')) result!.side = val;
    else if (key === 'align' && (val === 'start' || val === 'center' || val === 'end')) result!.align = val;
    else if (key === 'offsetX') result!.offsetX = Number(val);
    else if (key === 'offsetY') result!.offsetY = Number(val);
    // width/height accept both numeric ('40' → 40 number) and string ('100%').
    else if (key === 'width') result!.width = stringVal !== undefined ? stringVal : Number(numVal);
    else if (key === 'height') result!.height = stringVal !== undefined ? stringVal : Number(numVal);
  }

  return result;
}

function parseTransitionObj(src: string): CursorTransition {
  const result: CursorTransition = {};
  const inner = src.slice(1, -1);
  const regex = /(\w+)\s*:\s*(?:'([^']*)'|"([^"]*)"|(-?\d+(?:\.\d+)?))/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(inner)) !== null) {
    const key = m[1];
    const val = m[2] ?? m[3] ?? m[4];
    if (key === 'type' && (val === 'spring' || val === 'tween' || val === 'instant')) {
      result.type = val;
    } else if (key === 'ease') {
      result.ease = val;
    } else if (
      key === 'stiffness' || key === 'damping' || key === 'mass' || key === 'duration'
    ) {
      const n = Number(val);
      if (!Number.isNaN(n)) (result as any)[key] = n;
    }
  }
  return result;
}
