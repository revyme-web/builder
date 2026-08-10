// cms-paste-gen.ts — VERBATIM copy/paste round-trip for CMS Collection Lists.
//
// Why this exists: the paste engine serializes a flat node TREE and re-emits plain
// JSX — which DROPS the `.map()` repeater, the CMS bindings (`{item.name}`,
// `url(${item.image})`), the pagination scaffold, and the CMS data import. A pasted
// collection list therefore came out EMPTY. Re-deriving all that from metadata is
// lossy (filters / sort / responsive / pagination detail), so instead we capture the
// container's EXACT source JSX at copy-time and re-insert it (id-renamed) at paste-
// time — the most faithful round-trip across every scenario (pagination, filters,
// responsive, replica state all ride along verbatim).
//
// Flow: copy → captureCollectionForPaste() stashes {rawJsx, bodyHooks, imports} on the
// clipboard. paste → after the engine creates the plain container, a post-step calls
// rebuildPastedCollectionInCode() to swap the plain inner content for the verbatim
// `.map()` JSX, inject the (renamed) pagination hooks, and add the imports.

import { findJSXElementByDataId, findClosingTag } from './cms-gen';
import { findTagClose, insertAfterLastImportLine } from './generator-utils';
import { paginationStateVar } from './cms-pagination-gen';
import { insertConstIntoEnclosingFn, listConfigVar, ensureResponsiveListHooks } from './cms-responsive-gen';
import { addCanvasNodeInCode } from './generator-crud';
import { ensureLocaleHook } from './scoped-expr';
import { trace } from '@/shared/debug-trace';

/** Verbatim snapshot of a CMS collection-list container for paste. */
export interface CollectionPaste {
  /** Original container data-id (the `.map()` parent). */
  id: string;
  /** Verbatim source JSX of the container element (the whole `.map()` chain). */
  rawJsx: string;
  /** Pagination hooks for this container (`const [visX,setVisX]=useState(N)`,
   *  useRef + IntersectionObserver useEffect for infinite). Verbatim. */
  bodyHooks: string[];
  /** Import lines the list references (CMS data `@/cms/<slug>.json`, LoadMore, Spinner). */
  imports: string[];
}

const setterFor = (v: string): string => 'set' + v.charAt(0).toUpperCase() + v.slice(1);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Capture a CMS collection-list container for verbatim copy/paste. Returns null if
 * the container can't be located (not a `.map()` parent in `code`).
 */
export function captureCollectionForPaste(
  code: string,
  containerId: string,
  source: string,
): CollectionPaste | null {
  const elStart = findJSXElementByDataId(code, containerId);
  if (elStart === -1) return null;
  const closing = findClosingTag(code, elStart);
  if (!closing) return null;
  const rawJsx = code.slice(elStart, closing.closeTagEnd); // closeTagEnd is exclusive (no +1 — else 1 trailing char leaks)

  // Pagination hooks for THIS container, keyed by its derived `visX` var.
  const stateVar = paginationStateVar(containerId);
  const setter = setterFor(stateVar);
  const refVar = stateVar + 'Ref';
  const bodyHooks: string[] = [];
  const grab = (re: RegExp) => { const m = code.match(re); if (m) bodyHooks.push(m[0]); };
  grab(new RegExp(`const \\[${stateVar}, ${setter}\\] = useState\\([^)]*\\);`));
  grab(new RegExp(`const ${refVar} = useRef\\([^)]*\\);`));
  // Responsive list config const (present only when the list has per-viewport /
  // per-variant Filter/Sort overrides — `const listCfgX = useResponsiveListConfig(...)`).
  grab(new RegExp(`const ${listConfigVar(containerId)} = useResponsiveListConfig\\([\\s\\S]*?\\);`));
  // Infinite-scroll observer effect (matches the single-statement shape emitted by
  // cms-pagination-gen — body has no nested `}, [` so the lazy stop is safe).
  grab(new RegExp(`useEffect\\(\\(\\) => \\{[\\s\\S]*?${refVar}[\\s\\S]*?\\}, \\[\\]\\);`));

  // Imports the list references (added verbatim on paste — the bindings are
  // module-level + name-stable, so no rename needed).
  const imports: string[] = [];
  const cmsImp = code.match(new RegExp(`import\\s+\\w+\\s+from\\s+['"]@/cms/${escapeRe(source)}\\.json['"];?`));
  if (cmsImp) imports.push(cmsImp[0]);
  if (/<LoadMore\b/.test(rawJsx)) {
    const m = code.match(/import\s+LoadMore\s+from\s+['"][^'"]+['"];?/);
    if (m) imports.push(m[0]);
  }
  if (/<Spinner\b/.test(rawJsx)) {
    const m = code.match(/import\s+Spinner\s+from\s+['"][^'"]+['"];?/);
    if (m) imports.push(m[0]);
  }

  trace.action('cms-paste:capture', { containerId, source, hookCount: bodyHooks.length, importCount: imports.length, rawLen: rawJsx.length });
  return { id: containerId, rawJsx, bodyHooks, imports };
}

/** Insert an import line after the last top-level import (deduped by the `from '...'` part). */
function addImportLine(code: string, importLine: string): string {
  const fromMatch = importLine.match(/from\s+(['"][^'"]+['"])/);
  if (fromMatch && code.includes(`from ${fromMatch[1]}`)) return code; // already imported
  return insertAfterLastImportLine(code, importLine.replace(/;?$/, ';')) ?? (importLine + '\n' + code);
}

/**
 * Rebuild a pasted CMS collection list. The paste engine already created a PLAIN
 * container at the new id (correct position / canvas-node); this swaps its inner
 * content for the verbatim id-renamed `.map()` JSX, transplants the `data-pagination`
 * marker onto the plain opening tag, injects the (renamed) pagination hooks into the
 * enclosing function, and adds the imports.
 *
 * `idMap` is the paste engine's oldId → newId map (container + all descendants).
 */
export function rebuildPastedCollectionInCode(
  code: string,
  cap: CollectionPaste,
  idMap: Map<string, string>,
): string {
  const newId = idMap.get(cap.id);
  if (!newId) return code;

  // Full text-rename map: every old data-id → new, PLUS the derived pagination var
  // (`visOld`→`visNew`, `setVisOld`→`setVisNew`). Longest-first so `setVisX` is
  // rewritten before the `visX` prefix can clobber it.
  const renames: Array<[string, string]> = [];
  for (const [oldId, nid] of idMap) if (oldId !== nid) renames.push([oldId, nid]);
  const oldVar = paginationStateVar(cap.id), newVar = paginationStateVar(newId);
  if (oldVar !== newVar) {
    renames.push([setterFor(oldVar), setterFor(newVar)]);
    renames.push([oldVar, newVar]);
  }
  // Responsive list config var (`listCfgX` → `listCfgY`).
  const oldCfg = listConfigVar(cap.id), newCfg = listConfigVar(newId);
  if (oldCfg !== newCfg) renames.push([oldCfg, newCfg]);
  renames.sort((a, b) => b[0].length - a[0].length);
  const applyRenames = (s: string): string => {
    let out = s;
    for (const [from, to] of renames) out = out.replace(new RegExp(escapeRe(from), 'g'), to);
    return out;
  };

  // CONTEXT DEMOTION: a collection list copied FROM a design component carries
  // component-only constructs that DON'T resolve on a normal PAGE and would crash it:
  //   - `initialVariant` — a component function param; undefined on a page (the
  //     `useResponsiveListConfig(..., initialVariant, ...)` arg + any `=== 'x'` ternary
  //     → ReferenceError). Replaced with `undefined` (resolver then uses base/viewport
  //     only; ternaries fall to their base branch).
  //   - `variants={xVariants}` — references a module-scope const that ISN'T copied to
  //     the page → ReferenceError. Stripped.
  //   - `layout={true}` + `initial={[...]}` / `animate={[...]}` — motion variant/FLIP
  //     wiring, meaningless (and the array forms referenced initialVariant) → stripped.
  // Skipped when the dest IS a component master (the constructs resolve there).
  const destIsComponentMaster = /export\s+default\s+withResponsiveProps\s*\(/.test(code);
  const demote = (s: string): string => destIsComponentMaster ? s : s
    .replace(/\s+layout=\{true\}/g, '')
    .replace(/\s+variants=\{[^}]*\}/g, '')
    .replace(/\s+initial=\{\[[^\]]*\]\}/g, '')
    .replace(/\s+animate=\{\[[^\]]*\]\}/g, '')
    .replace(/\binitialVariant\b/g, 'undefined');

  const renamedJsx = demote(applyRenames(cap.rawJsx));

  // Locate the plain pasted container.
  const plainStart = findJSXElementByDataId(code, newId);
  if (plainStart === -1) { trace.error('cms-paste:rebuild:plain-not-found', { newId }); return code; }
  const plainOpenEnd = findTagClose(code, plainStart + 1);
  const plainClose = findClosingTag(code, plainStart);
  if (plainOpenEnd === -1 || !plainClose) { trace.error('cms-paste:rebuild:plain-no-close', { newId }); return code; }

  // Inner content of the verbatim (renamed) element → replaces the plain inner.
  const rawOpenEnd = findTagClose(renamedJsx, 1);
  const rawClose = findClosingTag(renamedJsx, 0);
  if (rawOpenEnd === -1 || !rawClose) { trace.error('cms-paste:rebuild:raw-no-close', { newId }); return code; }
  const renamedInner = renamedJsx.slice(rawClose.contentStart, rawClose.closeTagStart);

  let result = code.slice(0, plainClose.contentStart) + renamedInner + code.slice(plainClose.closeTagStart);

  // Transplant the `data-pagination` marker onto the plain opening tag (the plain
  // paste may not carry it, and the round-trip parser keys pagination off it).
  const pagMatch = renamedJsx.slice(0, rawOpenEnd + 1).match(/\sdata-pagination="[^"]*"/);
  if (pagMatch) {
    const openTag = result.slice(plainStart, findTagClose(result, plainStart + 1) + 1);
    if (!/\sdata-pagination=/.test(openTag)) {
      const dataIdIdx = result.indexOf(`data-id="${newId}"`, plainStart);
      if (dataIdIdx !== -1) {
        const insertAt = dataIdIdx + `data-id="${newId}"`.length;
        result = result.slice(0, insertAt) + pagMatch[0] + result.slice(insertAt);
      }
    }
  }

  // Inject pagination + listCfg hooks into the enclosing function (renamed +
  // context-demoted so the listCfg's `initialVariant` arg becomes `undefined` on a
  // page; deduped).
  for (const hook of cap.bodyHooks) {
    const renamed = demote(applyRenames(hook));
    if (!result.includes(renamed)) result = insertConstIntoEnclosingFn(result, newId, renamed);
  }

  // Add imports (deduped by `from '...'`).
  for (const imp of cap.imports) result = addImportLine(result, imp);

  // Responsive list: ensure the page-level `@responsiveList` interpreter block
  // (__applyListConfig / __matchListFilter / useResponsiveListConfig) exists in the
  // destination (idempotent) — the verbatim `.map()` references `__applyListConfig`.
  if (/\b__applyListConfig\s*\(/.test(renamedJsx)) result = ensureResponsiveListHooks(result);

  // LOCALIZED list: the verbatim `.map()` head is
  // `localizeRows(<coll>, __activeLocale)`, so the destination needs the
  // `const __activeLocale = useLocale();` hook AND the next-intl import.
  // Neither travels with the capture — `bodyHooks` only collects the
  // PAGINATION consts, and `imports` only the cms/LoadMore/Spinner lines — so
  // pasting a translated collection onto a fresh page produced JSX referencing
  // a binding that did not exist: "__activeLocale is not defined", nothing
  // rendered (user report 2026-08-11, trace: `cms-paste:rebuild … hooks:0`).
  // `ensureLocaleHook` adds both and is idempotent, exactly like the
  // responsive-list line above.
  if (/\b__activeLocale\b/.test(renamedJsx)) result = ensureLocaleHook(result);

  trace.action('cms-paste:rebuild', { oldId: cap.id, newId, hooks: cap.bodyHooks.length, imports: cap.imports.length });
  return result;
}

/**
 * Duplicate a CMS collection-list container into the module-scope `canvasNodes`
 * fragment as a MAP-PRESERVING canvas node — the replica drag-out clone.
 *
 * Why this exists: the generic static-descriptor clone (buildCanvasCloneDescriptor)
 * walks the MODEL `node.children` (just the template row — the ghosts are DOM-only)
 * and treats the CMS-bound <Item/> as a leaf, so the dragged-out node lost the
 * `{items.map(...)}` wrapper, `key={idx}`, and every `item.*` prop binding → one
 * static unbound ghost. Instead we run the verbatim cms-paste round-trip targeting
 * canvasNodes: capture the source container's EXACT JSX, create a plain canvas-node
 * container (carrying the source's own layout styles + the canvas-drop position),
 * then swap its inner content for the id-renamed `.map()`. The parser re-detects
 * `collectionList` on a canvasNodes element (parser.ts canvasNodes-collectionList-
 * preserved) and renders every CMS ghost. The ORIGINAL stays in the page — the
 * caller hides it on the source replica (`hideInThis` / @container display:none).
 *
 * `suffix` is the unique id-rename suffix (e.g. `-cabc123`): the clone container id
 * is `sourceId + suffix` and every descendant data-id gets the same suffix. The
 * `.map()` iterator idents (`item`/`idx`) and the CMS data import are NOT data-ids,
 * so the bindings (`item.image`, `` linkHref={`/advisors/${item?._slug}`} ``) ride
 * along verbatim. `styles` is the merged container layout styles + absolute canvas
 * position.
 */
export function duplicateCollectionListToCanvasInCode(
  code: string,
  sourceId: string,
  source: string,
  suffix: string,
  styles: Record<string, string>,
): string {
  const cap = captureCollectionForPaste(code, sourceId, source);
  if (!cap) {
    trace.error('cms-paste:dup-to-canvas:capture-failed', { sourceId, source });
    return code;
  }
  const newId = sourceId + suffix;

  // Container tag + friendly name from the captured opening tag — keeps the
  // generator self-sufficient (no node-cache dependency).
  const openEnd = findTagClose(cap.rawJsx, 1);
  const openTag = openEnd === -1 ? cap.rawJsx : cap.rawJsx.slice(0, openEnd + 1);
  const tag = cap.rawJsx.match(/^<\s*([A-Za-z][\w.]*)/)?.[1] || 'div';
  const name = openTag.match(/\sdata-name="([^"]*)"/)?.[1];

  // canvasNodes is MODULE scope — it can't hold the per-page pagination hooks
  // (useState/useRef/useEffect live in the component fn). Strip the pagination
  // scaffold from the CANVAS copy so it renders ALL items without referencing any
  // function-scoped `visX`/`setVisX`/`visXRef` (which would be undefined at module
  // scope and crash the file). The page keeps its own paginated list untouched.
  //   · `.slice(0, visX)`               → removed (the `.map()` renders every item)
  //   · guard cond `visX < src.length`  → `false` (the LoadMore / Spinner-sentinel
  //                                        guard short-circuits → never evaluates
  //                                        its createElement, so no setVisX/ref ref)
  //   · `data-pagination="…"`           → removed (no round-trip pagination marker)
  //   · bodyHooks                       → dropped (can't live in canvasNodes)
  const visVar = paginationStateVar(sourceId);
  const capForCanvas: CollectionPaste = {
    ...cap,
    bodyHooks: [],
    rawJsx: cap.rawJsx
      .replace(new RegExp(`\\.slice\\(\\s*0\\s*,\\s*${escapeRe(visVar)}\\s*\\)`, 'g'), '')
      .replace(new RegExp(`${escapeRe(visVar)}\\s*<\\s*\\w+\\.length`, 'g'), 'false')
      .replace(/\sdata-pagination="[^"]*"/g, ''),
  };

  // Full id-rename map: container + every descendant data-id → +suffix.
  const idMap = new Map<string, string>();
  idMap.set(sourceId, newId);
  const idRe = /data-id="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = idRe.exec(capForCanvas.rawJsx))) {
    const oldId = m[1];
    if (!idMap.has(oldId)) idMap.set(oldId, oldId + suffix);
  }

  // 1. Plain canvas-node container at `newId` (carries layout styles + canvas pos).
  let next = addCanvasNodeInCode(code, { id: newId, type: tag, styles, name });
  // 2. Swap its empty inner for the id-renamed verbatim `.map()` (rebuild also
  //    demotes component-only constructs on a page + re-adds the CMS import, deduped).
  next = rebuildPastedCollectionInCode(next, capForCanvas, idMap);

  trace.action('cms-paste:dup-to-canvas', { sourceId, newId, source, tag, ghostIds: idMap.size - 1 });
  return next;
}
