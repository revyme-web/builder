// store.ts — Source of truth: project files → active file code → derived node map
//
// ARCHITECTURE:
// - projectFS holds all files (project-fs.ts)
// - activeCodeAtom reads/writes the active file (active-file-store.ts)
// - codeAtom is an ADAPTER that delegates to activeCodeAtom (backward compat)
// - nodesAtom parses the active file's JSX into a flat node map
// - Cache helpers allow imperative-first pattern (DOM first, code catches up)

import { atom, getDefaultStore } from 'jotai';
import { parseJSXToNodes, type CanvasNode } from '../parsing/parser';
import { computeLayoutBrackets } from '@/shared/flex-helpers';
import { parseProjectFile, resolveInstancePropOverrides } from '../parsing/project-parser';
import { getTemplateRouteValues, substituteTemplateVarAttrsForCanvas } from '../generation/template-route-parse';
import { substituteScrollVariantFromVarForCanvas } from '../generation/scroll-variant-gen';
import { parseAsync } from '../parsing/async-parser';
import { activeCodeAtom, activeFilePathAtom, isComponentFilePath, isComponentLikeFilePath, isLayoutFile, getLayoutForPage, getLayoutClientPath, filePathToSlug } from '../project/active-file-store';
import { projectFS, projectVersionAtom } from '../project/project-fs';
import { trace } from '@/shared/debug-trace';
import { deepEqualPlain } from '@/shared/deep-equal';

// ─── Code Atom (adapter) ───────────────────────────────────────────────────
// Existing consumers import codeAtom. It now delegates to activeCodeAtom via
// a derived atom (NOT a direct alias). This is critical for module load order:
// `export const codeAtom = activeCodeAtom` evaluates eagerly and crashes with
// `Cannot access 'activeCodeAtom' before initialization` whenever the module
// graph is loaded in an order where active-file-store.ts hasn't fully
// evaluated yet (which happens via the active-file-store → mutation-queue →
// generator-styles → viewport-store → active-file-store cycle). Wrapping in
// `atom(get => get(activeCodeAtom), ...)` defers the reference into a
// function body that runs at first atom read, by which point all modules
// have finished loading.

export const codeAtom = atom(
  (get) => get(activeCodeAtom),
  (get, set, value: string | ((prev: string) => string)) => {
    const next = typeof value === 'function' ? value(get(activeCodeAtom)) : value;
    set(activeCodeAtom, next);
  },
);

// ─── Layout Helpers ─────────────────────────────────────────────────────────

/**
 * Index of `dataId`'s JSX-ATTRIBUTE occurrence in `code` — i.e. `data-id="…"`
 * sitting inside an opening tag — or -1 when the node has no JSX tag.
 *
 * A plain `code.includes('data-id="X"')` scan FALSE-POSITIVES on the same
 * string appearing in the component's SCRIPT logic — e.g. an overlay effect's
 * `document.querySelector('[data-id="overlay-…"]')` above the JSX. That one
 * off-by-substring shifted the {children} splice index in the template merge,
 * putting the page sections AFTER the template footer in the merged children
 * array (masked at rest by the footer's `order`, but the drag-time
 * `layout::` bracket keyed off the array order and skipped the footer — the
 * "template footer rides to the top while dragging a section" bug).
 *
 * The builder writes `data-id` as the FIRST attribute, so requiring a tag
 * open (`<Name `) with no `>` in between is reliable; a fallback to the raw
 * index keeps behavior for exotic hand-written markup.
 */
export function jsxDataIdIndex(code: string, dataId: string): number {
  const esc = dataId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('<[A-Za-z][\\w.]*[^>]*?data-id="' + esc + '"');
  const m = re.exec(code);
  if (m) return m.index;
  return code.indexOf(`data-id="${dataId}"`);
}

/**
 * Find which node is the parent of {children} in layout code.
 * The parent has children both BEFORE and AFTER {children} in source.
 * Fallback: the root node if {children} is its only non-element content.
 */
function findChildrenParentId(
  code: string,
  childrenIdx: number,
  nodes: Map<string, CanvasNode>,
): string | null {
  // Tag-anchored (jsxDataIdIndex): a data-id referenced from SCRIPT logic
  // (querySelector strings) above the JSX must not count as a pre-slot
  // sibling — same substring false-positive that mis-spliced the merge.
  for (const [id, node] of nodes) {
    if (!node.children.length) continue;
    const kidIdxs = node.children.map(cid => jsxDataIdIndex(code, cid)).filter(i => i !== -1);
    const hasBefore = kidIdxs.some(i => i < childrenIdx);
    const hasAfter = kidIdxs.some(i => i >= childrenIdx);
    if (hasBefore && hasAfter) return id;
  }
  // Fallback: root node
  for (const [id, node] of nodes) {
    if (!node.parentId) {
      const i = jsxDataIdIndex(code, id);
      if (i !== -1 && i < childrenIdx) return id;
    }
  }
  return null;
}

// ─── Nodes Atom ─────────────────────────────────────────────────────────────

// Eager parse so imperative helpers (isComponentInstanceInCache,
// getNodeFromCache, etc.) see a populated map even if read before the first
// nodesAtom getter runs.
let _cachedNodes: Map<string, CanvasNode> = parseJSXToNodes(
  projectFS.readFile('app/page.tsx') ?? ''
);
// Sentinel that can't match any real code string — forces the first
// nodesAtom read to take the full parse + layout-merge path. Without this,
// the previous eager init pre-parsed `app/page.tsx` (no layout merge) and
// the cache check `code === _cachedCode` short-circuited the merge until
// the user made an edit. Layout (navbar/footer) was missing on initial
// load.
let _cachedCode: string = '__uninitialized__';

// Layout merge depends on the active file's PATH (Template assignment moves
// a page between route groups so it picks up a different layout chain).
// Including the path in the dedup key matters because picking a Template
// keeps the page content byte-identical but changes which layout wraps it
// — a code-only check would skip the merge and the canvas would stay
// stale until the next unrelated edit.
let _cachedFilePath: string = '';
// projectVersion at last cache build. When OTHER files change (master files,
// component files, icon-set masters) but the active page's own code hasn't,
// `code === _cachedCode` would short-circuit the re-parse — so an instance
// pointing at a freshly-edited master keeps rendering its stale compiled
// version. Including the version in the cache key forces re-parse so
// CodeComponentHost re-syncs and the live React mount picks up new source.
let _cachedVersion: number = -1;

/** Node IDENTITY preservation across re-parses. A fresh parse emits ALL-NEW
 *  node objects — for a one-node edit on an ~860-node page, the other ~859
 *  unchanged nodes still get new refs, so every ref-equality consumer
 *  (selectAtom per-node subscriptions, React.memo, useMemo deps keyed on a
 *  node) sees "everything changed" and the whole editor cascades on every
 *  commit (the big-page "~1s after any drag" sluggishness; an empty page has
 *  nothing to cascade → instant). Swapping each unchanged fresh node for its
 *  previous-generation object (deep-equal ⇒ identical content, so this is a
 *  pure identity optimization) makes those equality checks WORK. When every
 *  node is preserved and the sizes match, the PREVIOUS Map instance itself is
 *  returned — jotai then skips notifying nodesAtom dependents entirely
 *  (Object.is on the atom value), e.g. a projectVersion bump from an
 *  unrelated file write.
 *
 *  Invariant this relies on (existing codebase convention): node objects are
 *  treated as immutable after parse — all imperative cache updaters clone
 *  (`{ ...existing }`) rather than mutate in place. */
function preserveNodeIdentities(
  prev: Map<string, CanvasNode>,
  next: Map<string, CanvasNode>,
): Map<string, CanvasNode> {
  if (prev === next || prev.size === 0) return next;
  const t0 = performance.now();
  let kept = 0;
  for (const [id, newNode] of next) {
    const oldNode = prev.get(id);
    if (!oldNode) continue;
    if (oldNode === newNode) { kept++; continue; }
    if (deepEqualPlain(oldNode, newNode)) {
      next.set(id, oldNode);
      kept++;
    }
  }
  const allKept = kept === next.size && prev.size === next.size;
  trace.fn('nodesAtom:identity-preserve', {
    duration: `${(performance.now() - t0).toFixed(1)}ms`,
    kept,
    total: next.size,
    sameMap: allKept,
  });
  return allKept ? prev : next;
}

/** The FULL node-map derivation for one (code, filePath, version) input:
 *  parse (project parser when components/icon-sets/CDN imports exist), layout
 *  placeholder injection / layout merge with per-page template props, then
 *  node identity preservation. Extracted from the nodesAtom getter VERBATIM so
 *  the same derivation can run IMPERATIVELY (undo/redo restore) without
 *  touching codeAtom — the memo keys are seeded, so the later atom read (the
 *  deferred fan-out's setCode) is a pure MEMO HIT: one parse per restore,
 *  atoms and imperative callers always agree. */
function deriveAndCacheNodes(code: string, filePath: string, version: number): void {
      // Previous-generation map — after the parse + merge below, unchanged
      // nodes get their old object identity back (see preserveNodeIdentities).
      const prevNodes = _cachedNodes;

      _cachedFilePath = filePath;
      _cachedVersion = version;
      const pt0 = performance.now();
      _cachedCode = code;

      // Use project parser if there are component, code component, OR icon-set files,
      // otherwise fast single-file parse. Without including icons/, an
      // icon-set instance (`<HuWoRe name="icon-1" />`) parsed via the simple
      // path never gets `isCodeComponent: true`, so CodeComponentHost finds
      // zero code components and the icon never mounts on canvas.
      //
      // ALSO use the project parser when the active file imports anything
      // from a CDN URL (`https://assets.revyme.app/components/...` or
      // `.../vectors/...`). The simple
      // `parseJSXToNodes` doesn't run import resolution, so a fresh
      // project that pastes a CDN URL would never get the instance node
      // marked `isCodeComponent` — empty render, no network request, no
      // mount. The project parser's CDN-detection branch (in
      // project-parser.ts) is what bridges the import line to the
      // runtime mount path. BOTH prefixes need to be checked here
      // so a project whose only CDN reference is a vector
      // still triggers the project-parser path.
      const hasComponents = projectFS.listFiles('components/').some(f => f.endsWith('.tsx'));
      const hasIconSets = projectFS.listFiles('icons/').some(f => f.endsWith('.tsx'));
      const hasCdnImport =
        code.includes('assets.revyme.app/components/') ||
        code.includes('assets.revyme.app/vectors/');
      // Editing the TEMPLATE (LayoutClient) directly renders the variable DEFAULTS — the param-signature
      // values, kept in sync with the variable modal's Default editor. design-tool parity: the master shows
      // defaults; per-page `__templateProps["/"]` overrides are PAGE-level and bake in at the layout-merge
      // for the PAGE view (below), NOT here. Previously we resolved the template against the `/` route's
      // overrides, so the master wrongly painted the Home page's values (e.g. a border var's modal default
      // was ignored in favour of the per-page border). No route propOverrides for the master view.
      // `code` — NOT a re-read of projectFS — is the source of truth for the
      // ACTIVE file (sub-components still resolve from `fs`; that's what
      // parseProjectFile's codeOverride means). For the nodesAtom caller the
      // two are the same string: activeCodeAtom's getter IS
      // `projectFS.readFile(activeFilePath)`. They diverge only in the
      // canvas-first windows, where `code` is the committed truth and projectFS
      // is deliberately behind — `activeCodeAtom`'s SETTER does the projectFS
      // write, and the deferred-drag-flush stash skips it for a whole gesture.
      // Passing `undefined` here silently re-read the stale file on any project
      // with a `components/` or `icons/` folder (i.e. nearly all of them), so
      // `seedNodesForCode(committedCode)` returned the PRE-commit tree: a
      // mid-drag clone extraction seeded 19 nodes without the clone it had just
      // committed, `shouldSkipLaggingForcedRender` then vetoed the render for
      // that exact id, and the dragged element stayed unmounted until mouseup
      // (user trace 2026-08-04). Undo/redo's restore seed had the same hole.
      _cachedNodes = (hasComponents || hasIconSets || hasCdnImport)
        ? parseProjectFile(filePath, projectFS, code, undefined)
        : parseJSXToNodes(code);

      trace.fn('nodesAtom:parse', {
        duration: `${(performance.now() - pt0).toFixed(1)}ms`,
        nodeCount: _cachedNodes.size,
        filePath,
        mode: hasComponents ? 'project' : 'single',
      });

      // ─── Layout merge ─────────────────────────────────────────────────
      // When editing a page: layout root becomes viewport root, page root
      // is reparented as a flex child at the {children} position.
      // When editing a layout: inject a placeholder node for {children}.
      if (!isComponentFilePath(filePath)) {
        const editingLayout = isLayoutFile(filePath);

        if (editingLayout) {
          // ── Layout editing: inject {children} placeholder ──
          const layoutCode = code;
          const childrenIdx = layoutCode.indexOf('{children}');
          if (childrenIdx >= 0) {
            const slotParentId = findChildrenParentId(layoutCode, childrenIdx, _cachedNodes);

            if (slotParentId && _cachedNodes.has(slotParentId)) {
              const parentNode = _cachedNodes.get(slotParentId)!;

              // Find insertion index: count siblings whose JSX TAG opens
              // before {children}. Tag-anchored (jsxDataIdIndex) — a raw
              // substring scan miscounts ids referenced in script logic
              // (querySelector strings) above the JSX.
              const origKids = [...parentNode.children];
              let insertIdx = 0;
              for (const kidId of origKids) {
                const tagIdx = jsxDataIdIndex(layoutCode, kidId);
                if (tagIdx !== -1 && tagIdx < childrenIdx) insertIdx++;
              }

              // Create placeholder node
              const slotNode: CanvasNode = {
                id: 'children-slot',
                type: 'slot',
                name: 'Page Content',
                parentId: slotParentId,
                children: [],
                styles: { flex: '1', minHeight: '200px' },
                textContent: '',
                hasMixedContent: false,
                attrs: {},
                isChildrenSlot: true,
                order: 0,
                isCanvasNode: false,
                componentFile: null,
                componentInstanceId: null,
                isComponentRoot: false,
                motionVariants: null,
                motionVariantsRef: null,
                motionProps: null,
                responsiveVariantMap: null,
                conditionalStyles: null,
              };

              // Insert into parent's children at correct position
              _cachedNodes = new Map(_cachedNodes);
              parentNode.children = [...origKids];
              parentNode.children.splice(insertIdx, 0, 'children-slot');
              _cachedNodes.set(slotParentId, parentNode);
              _cachedNodes.set('children-slot', slotNode);

              trace.action('nodesAtom:placeholder-injected', { slotParentId, insertIdx });
            }
          }
        } else {
          // ── Page editing: merge layout tree around page content ──
          const layoutPath = getLayoutForPage(filePath);
          if (layoutPath) {
            const clientPath = getLayoutClientPath(layoutPath);
            // Parse the template through the FULL project parser (not bare
            // parseJSXToNodes) so COMPONENT INSTANCES inside the LayoutClient —
            // e.g. <NavHeader/> — are expanded, exactly like the page branch
            // above. Bare parseJSXToNodes leaves a component instance as an
            // empty shell, so a template's header/nav component renders as a
            // blank `layout::`-prefixed node on the canvas (the footer, being
            // inline markup, rendered fine — the tell-tale of this bug).
            const layoutFilePath = projectFS.readFile(clientPath) != null ? clientPath : layoutPath;
            const layoutCode = projectFS.readFile(layoutFilePath);
            if (layoutCode) {
              // Per-page template-variable values for THIS page's route. Computed
              // up front because they feed BOTH the parse (baking template vars
              // passed into COMPONENT-INSTANCE props — `<Frame color={myVar}/>` —
              // before expansion) AND the direct-style/text override pass below.
              const __slug = filePathToSlug(filePath);
              const __route = __slug === 'home' ? '/' : `/${__slug}`;
              const tplProps = getTemplateRouteValues(layoutCode, __route);
              // Bake template vars referenced in JSX attr expressions to their
              // per-page value BEFORE expansion, so the canvas resolves a var
              // passed into a component instance like the deploy's usePathname
              // does (the Renderer can't run Next.js). No-op without overrides.
              // Second pass bakes a template var bound as a Scroll Variant's
              // RESTING variant (`fromVar`) into that effect's canvas display
              // variant — `={var}` substitution can't reach it (it lives inside
              // the `data-scroll-variant` spec JSON, consumed at runtime via
              // `useState(var || …)`). Together they make the canvas show the
              // page's chosen resting variant (e.g. /advisors → Header "Desktop
              // Scrolled") exactly as deploy/preview resolves usePathname.
              const layoutCodeForParse = Object.keys(tplProps).length > 0
                ? substituteScrollVariantFromVarForCanvas(
                    substituteTemplateVarAttrsForCanvas(layoutCode, tplProps),
                    tplProps,
                  )
                : undefined;
              // Base-keyed route values (drop any `@<width>` per-viewport keys) drive the parser's
              // `propDefaults` so a template var bound in a STYLE — including the per-viewport
              // `(__mq ? color4 : color3)` ternary — resolves to THIS page's color, not the param
              // default. The `={var}` attr substitution above can't reach style/ternary bindings.
              const tplPropsBase: Record<string, string> = {};
              for (const [k, v] of Object.entries(tplProps)) if (!k.includes('@')) tplPropsBase[k] = v;
              const layoutNodes = parseProjectFile(layoutFilePath, projectFS, layoutCodeForParse, tplPropsBase);

              // Find which layout node contains {children}
              const childrenIdx = layoutCode.indexOf('{children}');
              const childrenParentId = childrenIdx >= 0
                ? findChildrenParentId(layoutCode, childrenIdx, layoutNodes)
                : null;

              if (!childrenParentId) {
                trace.error('nodesAtom:layout-no-children', { layoutPath });
              } else {
                // Collect original children lists before mutating
                const origChildren = new Map<string, string[]>();
                for (const [id, node] of layoutNodes) {
                  origChildren.set(id, [...node.children]);
                }

                // Find page root IDs (nodes without parent)
                const pageRootIds: string[] = [];
                for (const [id, node] of _cachedNodes) {
                  if (!node.parentId) pageRootIds.push(id);
                }

                // Create new map to avoid mutating during iteration
                _cachedNodes = new Map(_cachedNodes);

                // ── MERGE the template ONTO the page root ──────────────────
                // The template root and the page root are ONE viewport. The
                // template root TAKES OVER the page root's id (`root`), so
                // selecting / escaping to the viewport lands on `root` WITH the
                // template's layout (flex column) applied — there's no separate
                // `layout::root` ghost layer, and Escape from a section goes
                // straight to the viewport (same as a non-templated page).
                // The old page-root BOX is dropped (template owns the body
                // style); its CHILDREN (the page's sections) splice into the
                // {children} slot as flex children of the template column, so
                // they're constrained, not free-floating absolute. Every other
                // template node (header / footer / nav) stays `layout::`-
                // prefixed + locked.
                let templateRootOrigId: string | null = null;
                for (const [id, n] of layoutNodes) { if (!n.parentId) { templateRootOrigId = id; break; } }
                // Single page root is the norm. If somehow multiple, only the
                // first merges with the template root.
                const primaryPageRootId = pageRootIds[0] ?? null;
                const primaryPageRoot = primaryPageRootId ? _cachedNodes.get(primaryPageRootId) : null;
                const pageSectionIds = primaryPageRoot ? [...primaryPageRoot.children] : [];
                // Merged id of whichever template node holds {children}.
                const childrenParentMergedId = (childrenParentId === templateRootOrigId && primaryPageRootId)
                  ? primaryPageRootId
                  : 'layout::' + childrenParentId;

                for (const [origId, node] of layoutNodes) {
                  if (node.isCanvasNode) continue;
                  const isRoot = origId === templateRootOrigId;
                  // Template root → the page root's id (the merged viewport);
                  // everything else → `layout::`-prefixed.
                  const newId = (isRoot && primaryPageRootId) ? primaryPageRootId : 'layout::' + origId;

                  node.fromLayout = true;
                  node.id = newId;

                  const kids = (origChildren.get(origId) || []).map(c => 'layout::' + c);
                  // Splice the page's SECTIONS into the {children} position
                  // (NOT the page root — that layer is dropped).
                  if (origId === childrenParentId) {
                    // Tag-anchored count — see jsxDataIdIndex (querySelector strings above
                    // the JSX must not shift the splice; live bug: sections landed AFTER
                    // the template footer and the drag bracket skipped it).
                    let insertIdx = 0;
                    for (const kidId of (origChildren.get(origId) || [])) {
                      const tagIdx = jsxDataIdIndex(layoutCode, kidId);
                      if (tagIdx !== -1 && tagIdx < childrenIdx) insertIdx++;
                    }
                    kids.splice(insertIdx, 0, ...pageSectionIds);
                  }
                  node.children = kids;

                  node.parentId = isRoot
                    ? null
                    : (node.parentId === templateRootOrigId && primaryPageRootId
                        ? primaryPageRootId
                        : 'layout::' + node.parentId);

                  // Keep original styles (flex column, width, etc.) — Renderer
                  // applies viewport positioning on top. Setting the root under
                  // `primaryPageRootId` OVERWRITES the old page-root node, so its
                  // bg / minHeight are dropped (template owns the body style).
                  _cachedNodes.set(newId, node);
                }

                // BRACKET the template chrome around the page sections.
                // Stripping the sections' INLINE order below is not enough: a
                // replica's @media band CSS re-applies `order: N !important` to
                // page sections on the canvas, and the chrome (no order → 0)
                // then ties into the 0-group — on the MOBILE tile the template
                // footer painted right after the hero while desktop/tablet (no
                // bands) looked fine and the live site (sections in a real
                // {children} wrapper, separate flex context) was correct (user
                // report 2026-07-27). Same bracket the replica drag path uses:
                // leading chrome very LOW, trailing chrome very HIGH — no page
                // order, inline or banded, can interleave with it.
                {
                  const slotParentNode = _cachedNodes.get(childrenParentMergedId);
                  if (slotParentNode) {
                    for (const b of computeLayoutBrackets(slotParentNode.children)) {
                      const chrome = _cachedNodes.get(b.id);
                      if (chrome) {
                        chrome.styles = { ...(chrome.styles ?? {}), order: String(b.order) };
                        _cachedNodes.set(b.id, chrome);
                      }
                    }
                  }
                }

                // Reparent the page's sections onto the merged {children} parent.
                for (const secId of pageSectionIds) {
                  const sec = _cachedNodes.get(secId);
                  if (sec) {
                    sec.parentId = childrenParentMergedId;
                    // Strip the page section's flex `order`. The flatten makes
                    // it a sibling of the template's Header/CTA/Footer in ONE
                    // flex column; the page FILE's own 0-based `order` values
                    // collide with the template's (both start at 0), so the
                    // browser's flex layout VISUALLY interleaves them — e.g. the
                    // template's footer renders BEFORE the page's FAQ even though
                    // the DOM order is correct. The merged `children` array is
                    // already the right order (page sections spliced at the
                    // {children} position, in the page's source order), so
                    // removing `order` lets flex fall back to DOM order = the
                    // correct merged layout. Strip ONLY the page side — the
                    // template keeps its `order` so its own chrome stays put.
                    // Canvas-only: the page SOURCE keeps its `order`, and the
                    // live site renders the page inside a real `{children}`
                    // wrapper so the two files' orders never share a flex
                    // container (no collision there). `''` = remove the property.
                    sec.styles = { ...(sec.styles ?? {}), order: '' };
                    _cachedNodes.set(secId, sec);
                  }
                }

                // ── Per-page TEMPLATE variable values (canvas resolution) ──
                // A template is a component master; the LayoutClient's NATIVE
                // route map (`const __templateProps = {…}`, resolved at runtime
                // via usePathname in deploy + preview) holds each page's values.
                // The canvas Renderer doesn't run Next.js, so we bake that SAME
                // map's values for the active route. Component-instance props
                // were already baked into the parse above (layoutCodeForParse);
                // here we bake DIRECT style/text bindings onto the merged
                // `layout::` nodes. STRICTLY ADDITIVE — only runs when this page
                // set overrides, so untouched templated pages are byte-identical.
                // (`tplProps` was computed up front, before the parse.)
                if (Object.keys(tplProps).length > 0) {
                  const overrides = resolveInstancePropOverrides(tplProps, layoutCode);
                  for (const ov of overrides.values()) {
                    const target = _cachedNodes.get('layout::' + ov.nodeId);
                    if (!target) continue;
                    if (ov.kind === 'text') {
                      target.textContent = ov.value;
                    } else {
                      target.styles = { ...target.styles, [ov.cssProp]: ov.value };
                    }
                    _cachedNodes.set('layout::' + ov.nodeId, target);
                  }
                  trace.action('nodesAtom:template-props-applied', { count: overrides.size, keys: Object.keys(tplProps) });
                }

                trace.action('nodesAtom:layout-merged', {
                  layoutPath,
                  layoutNodeCount: layoutNodes.size,
                  childrenParentId: 'layout::' + childrenParentId,
                  pageRootIds,
                });
              }
            }
          }
        }
      }
      // Runs ONLY on a memo-miss (fresh parse + merge just replaced the map) —
      // give unchanged nodes their previous-generation identity back so
      // per-node subscribers and memo'd consumers can skip this commit.
      _cachedNodes = preserveNodeIdentities(prevNodes, _cachedNodes);
}

/** IMPERATIVE derivation for the undo/redo restore path: parse `code` for the
 *  CURRENT active file + project version NOW and seed the memo, WITHOUT
 *  setting codeAtom (the React fan-out stays deferred behind the visual).
 *  Returns the derived map for the immediate patch render. */
export function seedNodesForCode(code: string, versionOffset = 0): Map<string, CanvasNode> {
  const store = getDefaultStore();
  const filePath = store.get(activeFilePathAtom);
  // versionOffset anticipates a bump the caller has SCHEDULED but not yet
  // applied (undo/redo defers `_bumpVersion` ~34ms behind the visual). Keying
  // the seed to the POST-bump version makes the bump-triggered nodesAtom
  // recompute a pure memo HIT — without it, the deferred bump re-parsed the
  // whole page (~100ms) right when the selection overlay's catch-up poll
  // needed the thread.
  const version = store.get(projectVersionAtom) + versionOffset;
  deriveAndCacheNodes(code, filePath, version);
  trace.fn('store.seedNodesForCode', { filePath, version, nodeCount: _cachedNodes.size });
  return _cachedNodes;
}

export const nodesAtom = atom(
  (get) => {
    const code = get(codeAtom);
    const filePath = get(activeFilePathAtom);
    const version = get(projectVersionAtom);

    // Re-parse on code change, active-file change, OR project-version bump
    // (which fires when ANY file in projectFS changes — including master
    // files this page's instances depend on).
    if (code !== _cachedCode || filePath !== _cachedFilePath || version !== _cachedVersion) {
      deriveAndCacheNodes(code, filePath, version);
    }
    return _cachedNodes;
  },
  (_get, _set, nodes: Map<string, CanvasNode>) => {
    _cachedNodes = nodes;
  },
);

// ─── Cache Helpers (imperative-first pattern) ───────────────────────────────

export function isComponentInstanceInCache(nodeId: string): boolean {
  return _cachedNodes.get(nodeId)?.componentFile != null;
}

/** Get the set of properties overridden in a specific variant for a node.
 *  Returns null if node not found or has no motionVariants. */
export function getVariantOverriddenKeys(nodeId: string, variantName: string): Set<string> | null {
  const node = _cachedNodes.get(nodeId);
  if (!node) return null;
  const keys = new Set<string>();
  // Paint props (backgroundColor, opacity, …) live in the variants object.
  const variantStyles = node.motionVariants?.[variantName];
  if (variantStyles) {
    for (const k of Object.keys(variantStyles)) keys.add(k);
    // Motion transform props (x/y translate deltas, rotate, scale, skews —
    // plus legacy attrX/attrY absolutes) PAINT as this variant's own
    // `transform` (foldMotionTransforms). The component-primary mid-drag
    // mirror writes `transform` — without this mapping it clobbers the
    // variant's independent position/rotation live (the child visually syncs
    // to the primary drag, then snaps back on commit; live finds 2026-06-11).
    // A variant that owns any motion transform owns its transform.
    const hasOwn = (k: string) => variantStyles[k] != null && variantStyles[k] !== '';
    if (['x', 'y', 'attrX', 'attrY', 'rotate', 'rotateX', 'rotateY', 'rotateZ', 'scale', 'scaleX', 'scaleY', 'skewX', 'skewY'].some(hasOwn)) {
      keys.add('transform');
    }
    // POSITION-channel override (top-level svg wrapper / absolute box whose
    // variant position rides left/top in the entry): the mid-drag mirror
    // paints the primary's position as a `transform` translate — owning the
    // position must own the transform too, or the replica live-syncs the
    // primary drag and snaps back on mouseup (live report 2026-06-13, the
    // independently-positioned group following a primary drag).
    if (hasOwn('left') || hasOwn('top')) {
      keys.add('transform');
    }
  }
  // FLIP-routed layout props — the ROOT's per-variant SIZE (width/height) and order/
  // flexDirection/etc. — live as inline-style TERNARIES, captured by the parser in
  // `conditionalStyles` as { prop: { variant: value, default: value } }. A prop is
  // INDEPENDENTLY overridden on this variant only when it has an explicit branch for it
  // (a variant that falls through to `default` is still synced to the primary). Without this,
  // a variant with its own width still tracked the primary resize live (the user-reported bug).
  if (node.conditionalStyles) {
    for (const [prop, branchMap] of Object.entries(node.conditionalStyles)) {
      if (branchMap && Object.prototype.hasOwnProperty.call(branchMap, variantName)) keys.add(prop);
    }
  }
  return keys.size ? keys : null;
}

/** Read a node directly from the internal cache (bypasses atom staleness). */
export function getNodeFromCache(nodeId: string): CanvasNode | undefined {
  return _cachedNodes.get(nodeId);
}

/** Iterate every cached node (read-only) — for cross-node sweeps like the
 *  overlay re-homing in queueMutation. */
export function getAllCachedNodes(): Iterable<CanvasNode> {
  return _cachedNodes.values();
}

/** The full cached node map (read-only by convention — every mutator replaces
 *  the reference, so the returned map is a stable snapshot). LayersPanel
 *  derives its tree from THIS during drags: mid-drag reparents update the
 *  cache with no code re-parse, and `nodeTreeStructureVersionAtom` signals
 *  the re-read. */
export function getCachedNodesMap(): Map<string, CanvasNode> {
  return _cachedNodes;
}

/** Imperative CURRENT node map for event handlers / effects that don't need a
 *  subscription. Unlike `getCachedNodesMap()` (raw cache — can be stale if
 *  code changed since the last atom read), this runs the nodesAtom getter, so
 *  a pending re-parse happens first. Use this when migrating a component OFF
 *  the whole-map `useAtomValue(nodesAtom)` subscription whose only map use is
 *  inside callbacks — the callback reads fresh data at call time and the
 *  component stops re-rendering on every commit. */
let _preferCacheSnapshot = false;
/** Toggled by the mutation queue while a deferred fan-out is armed (drop /
 *  undo-redo restore). In that window codeAtom is INTENTIONALLY stale — the
 *  atom getter would memo-miss against a seeded/committed cache, re-parse the
 *  OLD code and CLOBBER the fresh cache (measured: version-bump-driven
 *  effects like PinConstraintLines calling getNodesSnapshot inside an undo's
 *  restore task). While set, snapshots serve the imperative cache — the
 *  freshest truth in that window. */
export function setPreferCacheSnapshot(v: boolean): void {
  _preferCacheSnapshot = v;
}

export function getNodesSnapshot(): Map<string, CanvasNode> {
  if (_preferCacheSnapshot && _cachedNodes.size > 0) return _cachedNodes;
  return getDefaultStore().get(nodesAtom);
}

/** Bumped on IMPERATIVE cache STRUCTURE changes (moveNodeInCache) so tree
 *  consumers (LayersPanel) re-derive mid-drag without a code re-parse.
 *  nodesAtom does NOT re-derive during a drag — the deferred-drag-flush
 *  stashes the whole setCode fan-out for perf (100ms+ parse per flush on big
 *  imports) — but the drag strategies keep this cache authoritative at every
 *  enter/exit commit, so the version bump is what re-nests the layer rows
 *  LIVE at the reparent moment. */
export const nodeTreeStructureVersionAtom = atom(0);

/** Bumped on IMPERATIVE cache STYLE changes (updateNodeInCache) so live
 *  cache-first readers (Properties panel via ControlProvider) re-render the
 *  moment a style commit lands — the parsed nodesAtom lags a drop by the
 *  deferred fan-out (intentionally: canvas-first), but the panel must not.
 *  Kept separate from nodeTreeStructureVersionAtom: style bumps fire on every
 *  slider tick and must not make LayersPanel re-derive its whole tree. */
export const nodeStylesVersionAtom = atom(0);

export function injectNodeIntoCache(node: CanvasNode): void {
  _cachedNodes = new Map(_cachedNodes);
  _cachedNodes.set(node.id, node);
  trace.fn('store.injectNodeIntoCache', { id: node.id });
}

export function updateNodeInCache(nodeId: string, styles: Record<string, string>): void {
  const existing = _cachedNodes.get(nodeId);
  if (!existing) return;
  _cachedNodes = new Map(_cachedNodes);
  const merged = { ...existing.styles, ...styles };
  // Remove empty-string keys — they mean "delete this property"
  for (const key in merged) {
    if (merged[key] === '') delete merged[key];
  }
  _cachedNodes.set(nodeId, { ...existing, styles: merged });
  // Style commit landed in the IMPERATIVE cache — wake live cache-first
  // readers (ControlProvider → the whole Properties panel) so the panel shows
  // the committed values IMMEDIATELY instead of waiting out the deferred
  // parse fan-out (~0.5s on a big page after a drop).
  getDefaultStore().set(nodeStylesVersionAtom, (v) => v + 1);
}

export function removeNodeFromCache(nodeId: string): void {
  _cachedNodes = new Map(_cachedNodes);
  _cachedNodes.delete(nodeId);
  for (const [, node] of _cachedNodes) {
    const idx = node.children.indexOf(nodeId);
    if (idx !== -1) {
      node.children = node.children.filter(id => id !== nodeId);
    }
  }
}

export function moveNodeInCache(nodeId: string, newParentId: string | null): void {
  const node = _cachedNodes.get(nodeId);
  if (!node) return;
  // CYCLE GUARD — refuse to link a node under itself or its own descendant.
  // A collection-list drag-out resolved its drop target onto the dragged
  // subtree itself (ghost rows share canonical data-ids), and the resulting
  // parentId cycle blew every recursive tree walker in the app (DragCoordinator
  // subtree nudge, LayersPanel rows) with a stack overflow (2026-07-29).
  // Walk-up is bounded by `seen` so it also terminates on an already-corrupt cache.
  if (newParentId) {
    const seen = new Set<string>();
    let cur: string | null = newParentId;
    while (cur) {
      if (cur === nodeId) {
        trace.error('store:moveNodeInCache-cycle-refused', { nodeId, newParentId });
        return;
      }
      if (seen.has(cur)) break;
      seen.add(cur);
      cur = _cachedNodes.get(cur)?.parentId ?? null;
    }
  }
  _cachedNodes = new Map(_cachedNodes);

  if (node.parentId) {
    const oldParent = _cachedNodes.get(node.parentId);
    if (oldParent) {
      _cachedNodes.set(node.parentId, { ...oldParent, children: oldParent.children.filter(id => id !== nodeId) });
    }
  }

  if (newParentId) {
    const newParent = _cachedNodes.get(newParentId);
    if (newParent) {
      _cachedNodes.set(newParentId, { ...newParent, children: [...newParent.children, nodeId] });
    }
  }

  // newParentId === null marks the node as a canvas-level node (no parent);
  // a PARENTED node is never canvas-level (a canvas node entering a frame
  // must drop the flag, or tree consumers reading this cache mid-drag place
  // it at both levels).
  _cachedNodes.set(nodeId, { ...node, parentId: newParentId, isCanvasNode: newParentId === null });
  // Structure changed — re-nest live tree consumers (LayersPanel mid-drag).
  getDefaultStore().set(nodeTreeStructureVersionAtom, (v) => v + 1);
}

// ─── UI State Atoms ─────────────────────────────────────────────────────────

/** All selected node IDs (multi-select). First element is primary. */
export const selectedIdsAtom = atom<string[]>([]);

/** Primary selected node ID — derived from selectedIdsAtom for convenience. READ-ONLY. */
export const selectedNodeAtom = atom<string | null>(
  (get) => get(selectedIdsAtom)[0] ?? null,
);

/**
 * Which viewport(s) each node of a MARQUEE selection was swept in — so the
 * selection overlay outlines a node on EVERY artboard the marquee covered
 * (desktop + tablet + mobile at once, standard), not only the
 * interacting viewport. `sig` is the sorted-ids signature of the selection
 * that produced the map: the overlay compares it against the CURRENT
 * selectedIds and ignores a stale map after any non-marquee selection
 * change — self-invalidating, no reset plumbing at other select sites.
 */
export interface MarqueeViewportSpread {
  sig: string;
  byNode: Record<string, string[]>;
}
export const marqueeViewportSpreadAtom = atom<MarqueeViewportSpread | null>(null);

export const hoveredIdAtom = atom<string | null>(null);
/** Full data-node-id of hovered element (includes ghost suffix like "card__1") */
export const hoveredNodeIdAtom = atom<string | null>(null);
/** The canvas node a LAYERS-PANEL drag is about to drop INSIDE (indicator
 *  position:'inside'), with the viewport tile it lives in. Drives the on-canvas
 *  solid drop-target outline (LayerDropHighlight) so the user sees which
 *  container will receive the dropped layer. null when not dragging or when the
 *  indicator is before/after (a sibling reorder, not a drop-into). */
export const layerDropTargetAtom = atom<{ nodeId: string; vpId: string } | null>(null);
export const hoveredViewportIdAtom = atom<string>('desktop');
export const canvasInteractingAtom = atom(false);
/** True only while a ROTATE interaction is in progress (single or group).
 *  A subset of canvasInteractingAtom — set alongside it by the rotate
 *  handlers. The InteractionOutline hides itself while rotating: its
 *  screen-corner outline can't track a live rotation cleanly and the
 *  stale box lingering behind the shape is visual noise. */
export const isRotatingAtom = atom(false);
export const updatingFromCanvasAtom = atom(false);

/** While a single-slot code-component connection is being RE-DRAGGED from
 *  its handle, holds that component's id — SlotConnectors hides the
 *  component's persistent connector so it looks "detached" for the drag.
 *  Cleared on drop (the connector reappears if no new target was chosen). */
export const slotReconnectDragAtom = atom<string | null>(null);

// ─── Stable code / version atoms ────────────────────────────────────────────
// Mirror codeAtom + projectVersionAtom but pause updates while the user is
// actively dragging or resizing (canvasInteractingAtom === true). The Renderer
// + nodesAtom keep deriving from the LIVE codeAtom so the canvas reflects the
// in-progress reparent immediately. Heavy panel parsers (overlay, motion
// path, page-variables, container queries, pseudo styles) and panel components
// derive from the STABLE atoms so the ~80–170ms "PropertiesPanel re-render
// cascade" doesn't fire on every reparent during a fast drag.
//
// Sync is done via an effect in Canvas.tsx — when canvasInteracting transitions
// to false, or when the live values change while not interacting, the stable
// atoms catch up. Plain primitive atoms here keep the contract pure.
export const stableCodeAtom = atom('');
// projectVersionAtom is defined in project-fs.ts to avoid an import cycle —
// the stable mirror lives there alongside it.

// Frozen snapshot of nodesAtom. PropertiesPanel + every tool below it derive
// from this so that a fast drag's per-reparent code change doesn't ripple a
// new node map through ~14 panel components on every frame. Synced from
// Canvas.tsx (same effect that drives stableCodeAtom) — updated only when
// canvasInteractingAtom is false.
export const stableNodesAtom = atom<Map<string, CanvasNode>>(new Map());

/** True when the active file should behave like a design-component MASTER —
 *  a real `components/` file OR a template (LayoutClient.tsx). Drives the
 *  accent-secondary re-skin, selection/hover theming, and the COMPONENT-style
 *  variable system everywhere this atom is read. A template IS a component (see
 *  `isComponentLikeFilePath`). Use the pure `isComponentFilePath` for the few
 *  genuinely `components/`-only branches (registry, path-segment colour). */
export const isComponentFileAtom = atom((get) => {
  return isComponentLikeFilePath(get(activeFilePathAtom));
});

/** True when the active file is a layout file */
export const isLayoutFileAtom = atom((get) => {
  return isLayoutFile(get(activeFilePathAtom));
});

/**
 * Write-only atom to trigger file switch from UI components that
 * don't have access to mutation queue setters (like LeftHeader).
 * Canvas.tsx watches this and performs the actual switch.
 */
export const pendingFileSwitchAtom = atom<string | null>(null);

/**
 * True when the selection should use the accent-secondary (purple) color.
 * Three cases qualify:
 *
 *   1. Single component INSTANCE selected on any page (design or code
 *      component master, including CDN-linked components).
 *   2. Multi-select on a page where EVERY selected node is a component
 *      instance. As soon as the multi-select includes any non-instance,
 *      the color falls back to regular accent — purple was "bleeding"
 *      from one instance to the whole group when mixed selections were
 *      common (page-level frames + a component card).
 *   3. Multi-select on a design/code component master file. Editing the
 *      master itself, all visual affordances stay purple. Single-select
 *      on a master uses regular accent so the multi-select highlight
 *      is still distinguishable.
 *
 * Icon sets (`icons/`) also use master-file
 * semantics and carry a `componentFile` pointer on their instances — but
 * the purple accent is reserved for design/code components only. So we
 * filter the path: only paths under `components/` qualify here.
 */
export const isComponentSelectedAtom = atom((get) => {
  // Master file: only when multi-select. Single-select uses regular accent.
  if (get(isComponentFileAtom)) {
    return get(selectedIdsAtom).length > 1;
  }

  const selectedIds = get(selectedIdsAtom);
  if (selectedIds.length === 0) return false;
  const nodes = get(nodesAtom);
  // qualifies = node is a component instance whose master is design/code
  // (paths under `components/` or CDN-hosted `assets.revyme.app/components/`).
  // Icons are excluded — they share instance plumbing but the
  // purple accent is reserved for real components.
  const qualifies = (id: string): boolean => {
    const node = nodes.get(id);
    const cf = node?.componentFile;
    if (cf == null) return false;
    if (isComponentFilePath(cf)) return true;
    if (cf.includes('assets.revyme.app/components/')) return true;
    return false;
  };

  // Multi-select: every selected node must qualify. As soon as one
  // non-instance is in the mix, purple would "bleed" onto the whole
  // group and visually overrule the dominant page-style accent.
  if (selectedIds.length > 1) {
    return selectedIds.every(qualifies);
  }
  // Single-select: classic case.
  return qualifies(selectedIds[0]);
});

/**
 * True when the selected node is a map template element or a child of one.
 * Only nodes with isCollectionTemplate (set by parser inside .map() callbacks) qualify.
 * The parent container that holds the .map() does NOT qualify — nor do its non-map siblings.
 */
export const isMapTemplateSelectedAtom = atom((get) => {
  const selectedId = get(selectedNodeAtom);
  if (!selectedId) return false;
  const nodes = get(nodesAtom);
  const node = nodes.get(selectedId);
  if (!node) return false;

  // The node itself or any ancestor must have isCollectionTemplate
  // AND the collection source must be __inline: (not CMS)
  let current: typeof node | undefined = node;
  while (current) {
    if (current.isCollectionTemplate) {
      // Verify the parent's collectionList is an inline map
      const parent = current.parentId ? nodes.get(current.parentId) : null;
      if (parent?.collectionList?.source?.startsWith('__inline:')) return true;
    }
    current = current.parentId ? nodes.get(current.parentId) : undefined;
  }
  return false;
});

/**
 * Which map item index is currently selected on canvas.
 * null = template (item 0) or non-map node.
 * 1+ = ghost copy at that index.
 * Set by ghost mousedown handler, cleared on non-map selection.
 */
export const mapItemIndexAtom = atom<number | null>(null);

/**
 * Derived: map context for the currently selected map item.
 * Returns the parent node (with collectionList), varName, and inlineMapData.
 * null when selection is not inside an inline map.
 */
export const mapContextAtom = atom((get) => {
  const selectedId = get(selectedNodeAtom);
  if (!selectedId) return null;
  const nodes = get(nodesAtom);
  const node = nodes.get(selectedId);
  if (!node) return null;

  let current: typeof node | undefined = node;
  while (current) {
    if (current.isCollectionTemplate) {
      const parent = current.parentId ? nodes.get(current.parentId) : null;
      if (parent?.collectionList?.source?.startsWith('__inline:')) {
        const templateId = parent.collectionList!.templateIds['default']
          || Object.values(parent.collectionList!.templateIds)[0];
        const varName = parent.collectionList!.source.replace('__inline:', '');
        return {
          parentNode: parent,
          templateId: templateId || current.id,
          varName,
          mapData: parent.inlineMapData || [],
        };
      }
    }
    current = current.parentId ? nodes.get(current.parentId) : undefined;
  }
  return null;
});

// ─── Variable modal request ─────────────────────────────────────────────────
// The "Create Variable" flow (ControlLabel chevron menu) creates the variable, then wants to open the
// manage modal on it. But for COMPOUND controls (Shadow/Fill/Border) the act of binding flips the
// control into its bound branch, which renders a DIFFERENT ControlLabel — unmounting the one that
// initiated creation and taking its local modal state with it (so the modal never appears). Hoisting
// the request to a global atom + a single <VariableModalHost> (mounted in PropertiesPanel) decouples
// the modal's lifetime from the transient ControlLabel, so it opens reliably for every control type.
export interface VariableModalRequest {
  property: string;
  propertyLabel: string;
  currentValue: string;
  /** The just-created (or bound) variable to open the modal on. */
  variableRef: string;
  /** Whether the Name field is editable (true right after creation). */
  nameEditable: boolean;
}

export const variableModalRequestAtom = atom<VariableModalRequest | null>(null);

// ─── Async Parse ────────────────────────────────────────────────────────────

let lastParsedCode = _cachedCode;

export function triggerAsyncParse(
  code: string,
  setNodes: (nodes: Map<string, CanvasNode>) => void,
): void {
  if (code === lastParsedCode) return;
  lastParsedCode = code;
  parseAsync(code, (nodes) => {
    setNodes(nodes);
  });
}
