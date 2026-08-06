// project-parser.ts — Multi-file parser with component resolution.
// Wraps the existing parseJSXToNodes with import resolution.
// When the active file contains <Navbar />, reads components/Navbar.tsx
// from ProjectFS and flattens its nodes into the canvas tree with boundary markers.

import { parseJSXToNodes, extractStyleCSS, type CanvasNode } from './parser';
import { CDN_HOST_BARE } from '@/shared/hosts';
import { isTruthy } from '@/code/values/value-eval';
import { extractImports, resolveImportPath } from '../components/import-resolver';
import { buildComponentRegistry, type ComponentInfo } from '../components/component-registry';
import { hasComponentControls } from '../components/controls-parser';
import { isIconSetCode } from '../icons/icon-set-template';
import { parseIconSetConfig } from '../icons/icon-set-config';
import { parseVariantConfig } from '../variants/variant-config';
import type { ProjectFS } from '../project/project-fs';
import { trace } from '@/shared/debug-trace';
import { WRAPPER_ONLY_STYLE_PROPS } from '@/shared/constants';

// ─── Component-file parse cache ──────────────────────────────────────────────
// `expandComponent` re-parses every referenced component file's JSX on EVERY
// project re-parse. But the eager `nodesAtom` derive fires on every mutation —
// including ones that don't touch any component (e.g. drawing a canvas frame).
// A debug trace showed adding ONE frame re-parsed 12 unchanged component files
// (the dominant cost, ~half the re-parse budget). Memoise the PURE parse:
// `parseJSXToNodes` is a deterministic function of the code string (it resets
// its own `idCounter`/`gateQueryMap` on entry — same code in, identical nodes
// out), so it's safe to cache keyed by the EXACT code (a full string key, not a
// hash — a hash collision would hand back the WRONG component's nodes).
//
// Critically, `expandComponent` MUTATES the returned nodes in place (prop→style
// overrides, CMS binding lowering, id prefixing), so we hand back a deep CLONE
// every call and keep the cached copy pristine. The clone (a memory copy of a
// handful of plain-data nodes) is far cheaper than a babel parse. The page parse
// path is untouched — only component sub-parses go through here.
const componentParseCache = new Map<string, Map<string, CanvasNode>>();
const COMPONENT_PARSE_CACHE_MAX = 128;

function parseComponentNodesCached(code: string): Map<string, CanvasNode> {
  const cached = componentParseCache.get(code);
  if (cached) {
    trace.fn('parseComponentNodesCached:hit', { codeLength: code.length, nodeCount: cached.size });
    return structuredClone(cached);
  }
  const parsed = parseJSXToNodes(code);
  // Store the pristine parse (never mutated — callers only ever get clones),
  // then evict the oldest entry FIFO so an edit-churned component can't grow
  // the cache without bound (Map preserves insertion order).
  componentParseCache.set(code, parsed);
  if (componentParseCache.size > COMPONENT_PARSE_CACHE_MAX) {
    const oldest = componentParseCache.keys().next().value;
    if (oldest !== undefined) componentParseCache.delete(oldest);
  }
  trace.fn('parseComponentNodesCached:miss', { codeLength: code.length, nodeCount: parsed.size });
  return structuredClone(parsed);
}

/** Test/diagnostic hook — drop all memoised component parses. */
export function clearComponentParseCache(): void {
  componentParseCache.clear();
  trace.action('project-parser:clearComponentParseCache', {});
}

/**
 * Parse a project file with component resolution.
 *
 * 1. Parse the file's JSX into nodes
 * 2. For each uppercase tag (component reference), resolve the import
 * 3. Parse the component file and flatten its nodes into the tree
 * 4. Mark component boundaries on nodes
 *
 * Returns the same flat Map<string, CanvasNode> that the rest of the system expects.
 */
export function parseProjectFile(
  filePath: string,
  fs: ProjectFS,
  // Optional in-memory override for the MAIN file's source. Used by the canvas
  // template-merge to parse a LayoutClient whose template-variable JSX attrs
  // have been baked to their per-page route values (see
  // substituteTemplateVarAttrsForCanvas) — sub-components are still read from
  // `fs` as normal. When omitted, reads the file from `fs` (the usual path).
  codeOverride?: string,
  // Per-route TEMPLATE variable values — resolve the main file's bindings (base + per-viewport
  // `mqvars` ternary) against these instead of the param defaults, so the canvas shows a template's
  // per-page colors WYSIWYG (the runtime `__tp` reassignment is invisible to the static parser).
  propOverrides?: Record<string, string>,
): Map<string, CanvasNode> {
  const code = codeOverride ?? fs.readFile(filePath);
  if (!code) return new Map();

  const t0 = performance.now();

  // Parse the main file
  const nodes = parseJSXToNodes(code, propOverrides);

  // Extract imports from the code
  const imports = extractImports(code);

  // Build component registry (cached)
  const registry = buildComponentRegistry(fs);

  // Expand component instances recursively (supports nested components).
  // Each pass expands one level. Repeat until no more component tags are found.
  // Max depth prevents infinite loops from circular component references.
  const expanded = new Set<string>(); // track expanded node IDs to avoid re-expanding
  const MAX_DEPTH = 10;

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    let expandedAny = false;

    // Snapshot current node IDs (can't iterate and mutate Map simultaneously)
    const currentNodeIds = [...nodes.keys()];

    for (const nodeId of currentNodeIds) {
      if (expanded.has(nodeId)) continue;
      const node = nodes.get(nodeId);
      if (!node) continue;

      if (isComponentTag(node.type)) {
        // Check imports from the file this node lives in
        const nodeFile = node.componentFile ?? filePath;
        const nodeCode = fs.readFile(nodeFile);
        if (!nodeCode) { trace.action('parseProjectFile:no-code', { nodeId, type: node.type, nodeFile }); continue; }

        const nodeImports = nodeFile === filePath ? imports : extractImports(nodeCode);
        if (!nodeImports.has(node.type)) { trace.action('parseProjectFile:not-in-imports', { nodeId, type: node.type, importKeys: [...nodeImports.keys()] }); continue; }

        const importSource = nodeImports.get(node.type)!;

        // CDN-hosted Code components — detect BEFORE resolving local path
        // (URL won't resolve locally). Matches `/components/...`
        // (code + design components) and `/vectors/...` (icon sets via
        // the CDN vector pipeline). Both render through the
        // same `CodeComponentHost` mount path on the canvas — the
        // bundle's exported component is just a React function
        // regardless of kind. Vectors rely on the
        // `name` JSX prop to pick a single variant; the consumer's
        // paste / drag flow seeds `name="icon-1"`
        // on the inserted tag so the master grid view doesn't render
        // in place.
        if (
          importSource.includes(`${CDN_HOST_BARE}/components/`) ||
          importSource.includes(`${CDN_HOST_BARE}/vectors/`)
        ) {
          node.isCodeComponent = true;
          node.componentFile = importSource; // store CDN URL as componentFile
          expanded.add(nodeId);
          expandedAny = true;
          trace.action('parseProjectFile:cdn-code-component-skip-expansion', { nodeId, type: node.type, url: importSource });
          continue;
        }

        const resolvedPath = resolveImportPath(importSource, nodeFile);
        trace.action('parseProjectFile:resolve-import', { nodeId, type: node.type, importSource, resolvedPath, exists: resolvedPath ? fs.exists(resolvedPath) : false });

        if (resolvedPath && fs.exists(resolvedPath)) {
          // Code components (those with @controls/@label/@comment annotations)
          // render live on canvas via the Babel-standalone runtime — skip JSX
          // expansion. Design components (made via makeComponent — same
          // directory, but no @controls) DO expand inline. The path alone is
          // not enough to tell them apart since both live in components/.
          const componentCode = fs.readFile(resolvedPath);
          const isLiveCodeComponent = componentCode ? hasComponentControls(componentCode) : false;
          if (isLiveCodeComponent) {
            node.isCodeComponent = true;
            node.componentFile = resolvedPath;
            expanded.add(nodeId);
            expandedAny = true;
            trace.action('parseProjectFile:code-component-skip-expansion', { nodeId, type: node.type, file: resolvedPath });
            continue;  // don't expand
          }

          // Icon-set instances (@iconSet annotation): render live via the
          // Babel-standalone runtime, same path as Code component/code components.
          // Inline expansion would require evaluating the `name` prop +
          // ICONS map at parse time and walking into the chosen function's
          // body — significant parser surgery for no real benefit, since
          // the file is a regular React component that runs fine under
          // the existing live runtime. This gives us free `name` swapping,
          // free re-renders on file edits, and zero coupling to the
          // expansion machinery.
          const isIconSetInstance = componentCode ? isIconSetCode(componentCode) : false;
          if (isIconSetInstance) {
            node.isCodeComponent = true;
            node.componentFile = resolvedPath;
            expanded.add(nodeId);
            expandedAny = true;
            trace.action('parseProjectFile:icon-set-skip-expansion', { nodeId, type: node.type, file: resolvedPath });
            continue;
          }

          const componentInfo = registry.get(node.type);
          if (componentInfo) {
            expandComponent(node, componentInfo, fs, nodes, nodeFile);
            expanded.add(nodeId);
            expandedAny = true;
          }
        }
      }
    }

    if (!expandedAny) break; // no more components to expand
    trace.fn('parseProjectFile:expansion-pass', { depth, expandedCount: expanded.size });
  }

  // Icon-set master file: merge iconConfig positions onto vector nodes.
  // The template emits content-only vectors (no inline left/top/width/
  // height) — positions live in iconConfig. For canvas rendering we
  // need them on the node styles so the existing renderer just works.
  if (isIconSetCode(code)) {
    const iconConfigs = parseIconSetConfig(code);
    for (const cfg of iconConfigs) {
      const vectorNode = nodes.get(cfg.name);
      if (!vectorNode) continue;
      vectorNode.styles = {
        ...vectorNode.styles,
        position: vectorNode.styles.position || 'absolute',
        left: `${cfg.x}px`,
        top: `${cfg.y}px`,
        width: `${cfg.width}px`,
        height: `${cfg.height}px`,
      };
      trace.action('parseProjectFile:iconConfig-merge', {
        nodeId: cfg.name, x: cfg.x, y: cfg.y, w: cfg.width, h: cfg.height,
      });
    }
  }

  // Component master file: override the variant root's left/top with
  // variantConfig[primary].x/y. The "Make Component" flow extracts a
  // page element into a master file but PRESERVES its original
  // page-position inline (e.g. `style={{ left: '1159px', top: '309px',
  // ... }}`) — that's where the element used to sit on the page
  // before extraction. On the master canvas the variant root renders
  // at variantConfig position via the Renderer (it overrides
  // `rootEl.style.left/top` with `vp.x/y` per viewport), but the
  // PARSED node still carries the stale inline left/top, which leaks
  // into the Position panel as wildly wrong "Space X / Y" values
  // (e.g. 1159, 309 instead of 0, 0). Merge variantConfig[primary]
  // values onto the parsed root so the panel shows what the user
  // sees on screen.
  //
  // Detection: master files have `variantConfig` at module scope.
  // Use string-includes (cheap, runs every parse) — full path-based
  // detection isn't available here without circular-importing
  // active-file-store.
  if (code.includes('variantConfig')) {
    const variantConfigs = parseVariantConfig(code);
    const primary = variantConfigs.find(v => v.isPrimary) ?? variantConfigs[0];
    if (primary) {
      // The variant root is the FIRST node with no parentId that
      // isn't a canvas-node (mirrors `findRootId` in
      // component-navigation.ts).
      let rootNode: typeof nodes extends Map<string, infer N> ? N | undefined : undefined;
      for (const node of nodes.values()) {
        // Skip overlay nodes: an overlay attached to the component ROOT is a
        // top-level (parentless) sibling, and grabbing it here makes it a phantom
        // variant tile (variantConfig x/y baked into the OVERLAY). It's portal-
        // rendered, never a variant root.
        if (!node.parentId && !node.isCanvasNode && !node.attrs?.['data-overlay']) { rootNode = node; break; }
      }
      if (rootNode) {
        rootNode.styles = {
          ...rootNode.styles,
          position: rootNode.styles.position || 'absolute',
          left: `${primary.x}px`,
          top: `${primary.y}px`,
        };
        trace.action('parseProjectFile:variantConfig-merge', {
          nodeId: rootNode.id, x: primary.x, y: primary.y,
        });
      }
    }
  }

  const duration = performance.now() - t0;
  trace.fn('parseProjectFile', {
    filePath,
    duration: `${duration.toFixed(1)}ms`,
    nodeCount: nodes.size,
    imports: imports.size,
    components: registry.size,
  });

  return nodes;
}

/**
 * Lower an instance's per-viewport PROP overrides (viewport → { propName: value })
 * to per-viewport STYLE overrides (viewport → { cssProp: value }) for ONE node,
 * using that node's `styleVariables` (cssProp → propName). A prop only contributes
 * to a node if the node actually binds it to a style (e.g. `flexDirection: direction`
 * → styleVariables['flexDirection'] === 'direction'). Returns null when nothing maps.
 */
function lowerResponsivePropsToStyles(
  styleVariables: Record<string, string> | undefined,
  responsiveProps: Record<number, Record<string, string>> | null,
): Record<number, Record<string, string>> | null {
  if (!styleVariables || !responsiveProps) return null;
  const out: Record<number, Record<string, string>> = {};
  for (const [vpStr, props] of Object.entries(responsiveProps)) {
    const vp = parseInt(vpStr, 10);
    if (isNaN(vp)) continue;
    for (const [cssProp, propName] of Object.entries(styleVariables)) {
      const v = props[propName];
      if (v === undefined) continue;
      if (!out[vp]) out[vp] = {};
      out[vp][cssProp] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

type RespBindingEntry = { field: string } | { value: string };

/**
 * Build the per-viewport CMS-binding overrides for ONE master node, from the
 * instance's per-viewport maps. Only props that are CMS-bound (base `item.field`
 * OR a per-viewport field-ref) are considered — for each such prop the node uses
 * via a binding marker (text `{prop}` / style `{{cssProp:prop}}` / attr `src={prop}`),
 * collect that prop's per-viewport field-ref (rebind) or literal (unbind→default).
 * Non-CMS responsive props (e.g. `gap`) are left to `lowerResponsivePropsToStyles`.
 */
function lowerResponsiveBindings(
  node: CanvasNode,
  cmsProps: Set<string>,
  fieldBindings: Record<number, Record<string, string>> | undefined, // vp → { prop: field }
  responsiveProps: Record<number, Record<string, string>> | null,    // vp → { prop: literalString }
): CanvasNode['responsiveBindings'] | null {
  if (cmsProps.size === 0 || (!fieldBindings && !responsiveProps)) return null;
  const out: NonNullable<CanvasNode['responsiveBindings']> = {};
  const vpSet = new Set<number>();
  if (fieldBindings) for (const k of Object.keys(fieldBindings)) vpSet.add(Number(k));
  if (responsiveProps) for (const k of Object.keys(responsiveProps)) vpSet.add(Number(k));
  const entryFor = (vp: number, prop: string): RespBindingEntry | null => {
    if (!cmsProps.has(prop)) return null;
    const f = fieldBindings?.[vp]?.[prop];
    if (f !== undefined) return { field: f };
    const lit = responsiveProps?.[vp]?.[prop];
    if (lit !== undefined) return { value: lit };
    return null;
  };
  for (const vp of vpSet) {
    if (isNaN(vp)) continue;
    if (node.textVariable) {
      const e = entryFor(vp, node.textVariable);
      if (e) { if (!out.text) out.text = {}; out.text[vp] = e; }
    }
    if (node.styleVariables) {
      for (const [cssProp, prop] of Object.entries(node.styleVariables)) {
        const e = entryFor(vp, prop);
        if (e) { if (!out.style) out.style = {}; if (!out.style[vp]) out.style[vp] = {}; out.style[vp][cssProp] = e; }
      }
    }
    if (node.attrPropRefs) {
      for (const [attrName, prop] of Object.entries(node.attrPropRefs)) {
        if (attrName !== 'src' && attrName !== 'href' && attrName !== 'alt') continue;
        const e = entryFor(vp, prop);
        if (e) { if (!out.attr) out.attr = {}; if (!out.attr[vp]) out.attr[vp] = {}; out.attr[vp][attrName] = e; }
      }
    }
  }
  return (out.text || out.style || out.attr) ? out : null;
}

/**
 * Expand a component instance by parsing the component file
 * and flattening its nodes as children of the instance node.
 */
function expandComponent(
  instanceNode: CanvasNode,
  componentInfo: ComponentInfo,
  fs: ProjectFS,
  allNodes: Map<string, CanvasNode>,
  _parentFilePath: string,
): void {
  const componentCode = fs.readFile(componentInfo.filePath);
  if (!componentCode) return;

  // Parse the component file's JSX (memoised — pure of `componentCode`; returns
  // a fresh deep clone so the in-place mutations below can't corrupt the cache).
  const componentNodes = parseComponentNodesCached(componentCode);
  if (componentNodes.size === 0) return;

  // Build prop→style overrides from instance attrs.
  // Instance has attrs like { spoOnO: '89px' } from <EffSdd spoOnO="89px" />.
  // Component code has: style={{ gap: spoOnO }} — meaning prop 'spoOnO' maps to CSS 'gap'.
  // We scan the component code for `styleProp: propName` patterns to build the mapping.
  //
  // `attrs` only holds STRING attributes (`prop="x"`) + a few specials; EXPRESSION literal values
  // (`prop={true}` / `prop={16}` / `prop={'x'}`) live in `componentProps`. Both must drive overrides,
  // otherwise a Toggle/Number/Option variable's instance value is ignored on the canvas (it works live
  // because real React passes the prop) — the user-reported "wrap=true doesn't wrap on canvas" bug.
  const instanceProps = { ...instanceNode.attrs, ...(instanceNode.componentProps ?? {}) };
  const propStyleOverrides = resolveInstancePropOverrides(instanceProps, componentCode);

  // Carry the master's <style> CSS (e.g. an overlay-border `::after`) onto the
  // canvas. The block is dropped when the instance flattens into the page node
  // tree, and its selectors key off the UNPREFIXED master id — so on the canvas
  // the overlay never matches the expanded element (`instanceId:masterId`) and
  // the border vanishes (live renders the master directly, so it works there).
  // Rewrite every `[data-(?:node-)?id="X"]` to the prefixed instance id and stow
  // it on the expanded ROOT node; the Renderer injects every node's `afterCSS`.
  // `var(--X)` references are NOT rewritten — custom-property names are stable
  // and the expanded root carries the resolved `--X` value (see prop overrides).
  let instanceAfterCSS = '';
  {
    const masterCSS = extractStyleCSS(componentCode);
    if (masterCSS) {
      instanceAfterCSS = masterCSS.replace(
        /\[data-(?:node-)?id="([^"]+)"\]/g,
        (_m, id) => `[data-id="${instanceNode.id}:${id}"]`,
      );
    }
  }

  // Resolve initialVariant — merge variant styles for the PRIMARY viewport.
  // For replica viewports with data-responsive overrides, the Renderer handles
  // per-viewport resolution (see resolveVariantStyles with responsiveVariantMap).
  let initialVariant = instanceNode.attrs?.initialVariant ?? null;

  // Scroll Variant carries an explicit canvas DISPLAY variant (`canvasVariant` in the
  // `data-scroll-variant` spec) — the variant the user had selected when the Scroll Variant
  // was added (or last picked in the Variant dropdown). It's INDEPENDENT of the spec's
  // `from`/`to` (the runtime morph endpoints), so the static canvas keeps showing the user's
  // pick and changing From/To never repaints it. When present it stands in for the
  // `initialVariant` prop the runtime binding (`initialVariant={…Sv}`) made unparseable.
  // Absent (legacy specs / no explicit pick) → null fallback → component base/default variant.
  const svRaw = instanceNode.attrs?.['data-scroll-variant'];
  if (svRaw) {
    try {
      const svSpec = JSON.parse(svRaw.replace(/^['"]|['"]$/g, ''));
      if (svSpec && typeof svSpec.canvasVariant === 'string') {
        initialVariant = svSpec.canvasVariant;
      }
    } catch { /* not valid JSON — ignore, keep the parsed initialVariant */ }
  }

  // The REAL `initialVariant` PROP value (a plain string). Null when the instance binds a
  // runtime expression (`initialVariant={…Sv}` from a Scroll Variant) AND the spec carries no
  // `canvasVariant` — the static parser can't resolve the binding. ONLY this seeds the
  // responsiveVariantMap primary (below) and bakes the default child variant.
  const attrInitialVariant = initialVariant;

  // Scroll Variant is RUNTIME-only — its `from`/`to` describe the scroll morph, NOT the
  // canvas display. We DON'T pin the canvas variant to the spec's `from`: that made changing
  // "From" repaint the static canvas (e.g. From=abc2 turned every tile dark). The canvas
  // variant comes from `canvasVariant` (the user's explicit pick, above) or — failing that —
  // data-responsive per-tile choices; with neither, attrInitialVariant stays null → no baking,
  // no seeding → resolveVariantStyles falls back to the component's BASE styles.

  // Per-parent-variant child variant overrides via JSX ternary:
  //   <Child initialVariant={initialVariant === 'variant-1' ? 'variant-2' : 'default'} />
  // The parser captured this as instanceNode.attrConditional.initialVariant =
  // { 'variant-1': 'variant-2', default: 'default' }. We expand it into:
  //   - defaultChildVariant: which CHILD variant applies on the parent's
  //     PRIMARY viewport (and any parent viewport without an explicit
  //     override). Baked into the expanded child's BASE styles.
  //   - perParentOverrides: parent variant name → CHILD variant name (only
  //     for parent variants that explicitly override the default). Drives
  //     the remapped motionVariants below.
  const instanceConditional = instanceNode.attrConditional?.initialVariant ?? null;
  let defaultChildVariant: string | null = null;
  const perParentOverrides: Record<string, string> = {};
  if (instanceConditional) {
    defaultChildVariant = instanceConditional['default'] ?? null;
    for (const [parentVariant, childVariant] of Object.entries(instanceConditional)) {
      if (parentVariant === 'default') continue;
      perParentOverrides[parentVariant] = childVariant;
    }
  } else if (initialVariant) {
    // Plain string initialVariant — applies to ALL parent variants by baking
    // it into base styles. No per-parent overrides.
    defaultChildVariant = initialVariant;
  }

  // Parse data-responsive to build viewport→initialVariant map for canvas rendering.
  // This lets the Renderer show different variants per viewport replica.
  //
  // For NESTED instances (those that already live inside an outer
  // expansion), inherit the outer parent's responsiveVariantMap as the
  // baseline. The outer expansion stamped it onto this instance node when
  // it was lifted into the page-level `nodes` map, so reading it back
  // here propagates the page→viewport→variant mapping down to the
  // nested expansion's children. Without this propagation the nested
  // descendants render at default on tablet/mobile even when the user
  // chose a non-default variant for that breakpoint.
  // The instance's OWN breakpoint list (`_bp` from data-responsive) — the
  // live runtime buckets a width against THIS list before looking up an
  // override, so the canvas must too (see responsiveVariantForWidth). Without
  // it, a map-keys-only interval walk cascades PAST the primary's bucket when
  // a replica is WIDER than the primary (map {796: v1, 1409: v2}, primary
  // 1277 → cascaded to 1409's variant; live correctly showed primary).
  let responsiveVariantBp: number[] | null = instanceNode.responsiveVariantBp
    ? [...instanceNode.responsiveVariantBp]
    : null;
  let responsiveVariantMap: Record<number, string> | null = instanceNode.responsiveVariantMap
    ? { ...instanceNode.responsiveVariantMap }
    : null;
  // Per-viewport PROP overrides (every data-responsive entry EXCEPT initialVariant, which
  // becomes responsiveVariantMap above) — e.g. {768:{direction:'column'}}. Lowered to the
  // styles each prop drives (via styleVariables) at the allNodes.set below, so the canvas
  // replica tiles resolve them just like withResponsiveProps does on the live site.
  let responsiveProps: Record<number, Record<string, string>> | null = null;
  // Breakpoints whose variant came from an EXPLICIT data-responsive override (the user's per-tile pick). The
  // inline-ternary variant fold below must NOT clobber these — on the live site withResponsiveProps overrides
  // the base `initialVariant` prop (incl. a `__mq ? a : b` ternary) with data-responsive, so data-responsive
  // WINS. (A stale inline ternary lingers after a per-viewport variant VARIABLE is deleted → inlined to a
  // literal; without this guard it overwrote the user's new pick → canvas showed the old variant.)
  const dataRespVariantWidths = new Set<number>();
  const respAttr = instanceNode.attrs?.['data-responsive'] ?? null;
  if (respAttr) {
    try {
      const parsed = JSON.parse(respAttr);
      const bpRaw: unknown[] = Array.isArray((parsed as any)?._bp) ? (parsed as any)._bp : [];
      const bpNums = bpRaw.map((w) => (typeof w === 'number' ? w : parseInt(String(w), 10))).filter((n) => Number.isFinite(n) && n > 0);
      if (bpNums.length > 0) responsiveVariantBp = bpNums;
      for (const [key, val] of Object.entries(parsed)) {
        if (key === '_bp') continue;
        const vpWidth = parseInt(key, 10);
        if (isNaN(vpWidth) || typeof val !== 'object' || !val) continue;
        const entry = val as Record<string, any>;
        if (entry.initialVariant) {
          if (!responsiveVariantMap) responsiveVariantMap = {};
          responsiveVariantMap[vpWidth] = entry.initialVariant;
          dataRespVariantWidths.add(vpWidth);
        }
        for (const [pk, pv] of Object.entries(entry)) {
          if (pk === 'initialVariant') continue;
          if (!responsiveProps) responsiveProps = {};
          if (!responsiveProps[vpWidth]) responsiveProps[vpWidth] = {};
          responsiveProps[vpWidth][pk] = String(pv);
        }
      }
      // Seed every breakpoint with NO explicit override with a NON-DEFAULT base
      // initialVariant. The live runtime (withResponsiveProps) only OVERRIDES
      // initialVariant for the breakpoints listed in data-responsive; the primary
      // (and any unlisted) breakpoint keeps the base `initialVariant` prop. Without
      // this the canvas resolveVariantStyles falls back to 'default' on the primary
      // viewport — re-applying the default variant's styles OVER the base variant that
      // expandComponent baked in, so the instance renders 'default' on desktop while the
      // live site shows the chosen variant. (Skip when base IS 'default' — that's already
      // the resolveVariantStyles fallback, so seeding it would only bloat the map.)
      if (attrInitialVariant && attrInitialVariant !== 'default') {
        const bp: unknown[] = Array.isArray((parsed as any)?._bp) ? (parsed as any)._bp : [];
        if (bp.length) {
          if (!responsiveVariantMap) responsiveVariantMap = {};
          for (const w of bp) {
            const wn = typeof w === 'number' ? w : parseInt(String(w), 10);
            if (!isNaN(wn) && responsiveVariantMap[wn] === undefined) responsiveVariantMap[wn] = attrInitialVariant;
          }
        }
      }
    } catch { /* ignore parse errors */ }
  }

  // PER-VIEWPORT INSTANCE-PROP VARIABLES (the inline `prop={__mqN ? var : base}` rail): the parser
  // already resolved each branch variable to its value in `responsiveAttrPropValues[prop][vpWidth]`.
  // Fold them into `responsiveProps` (last-wins over any data-responsive literal) so they ride the
  // SAME `lowerResponsivePropsToStyles` → `responsivePropStyles` → Renderer per-tile fold as
  // data-responsive overrides — no new Renderer code path needed.
  if (instanceNode.responsiveAttrPropValues) {
    for (const [prop, byW] of Object.entries(instanceNode.responsiveAttrPropValues)) {
      for (const [w, val] of Object.entries(byW)) {
        const vpWidth = parseInt(w, 10);
        if (isNaN(vpWidth)) continue;
        if (prop === 'initialVariant') {
          // Variant SELECTION rides the variant map (per-tile variant), NOT the prop→style lowering. Skip
          // when an EXPLICIT data-responsive override already set this tile — that's the user's current pick
          // and it must win over a stale inline ternary (matches the live withResponsiveProps precedence).
          if (!dataRespVariantWidths.has(vpWidth)) {
            if (!responsiveVariantMap) responsiveVariantMap = {};
            responsiveVariantMap[vpWidth] = String(val);
          }
        } else {
          if (!responsiveProps) responsiveProps = {};
          if (!responsiveProps[vpWidth]) responsiveProps[vpWidth] = {};
          responsiveProps[vpWidth][prop] = String(val);
        }
      }
    }
  }

  // PER-VIEWPORT TEXT props → the child's responsiveTextValues rail. The
  // style-driving props lower via styleVariables below, but a TEXT variable's
  // per-tile literal (data-responsive {768:{content:"bnbub"}} — written by the
  // per-replica prop override / locale-removal flows) had NO canvas fold:
  // live (withResponsiveProps merge) showed it, every canvas tile kept the
  // base ("bnbub resolves live but not on canvas", 2026-07-22). Stamp it on
  // every expanded child bound to that text variable — the Renderer already
  // resolves responsiveTextValues per tile.
  if (responsiveProps) {
    for (const child of componentNodes.values()) {
      if (!child.textVariable) continue;
      for (const [wStr, props] of Object.entries(responsiveProps)) {
        const v = (props as Record<string, string>)[child.textVariable];
        if (v === undefined) continue;
        const w = parseInt(wStr, 10);
        if (isNaN(w)) continue;
        if (!child.responsiveTextValues) child.responsiveTextValues = {};
        child.responsiveTextValues[w] = v;
      }
    }
  }

  // NOTE: the canvas variant comes ENTIRELY from `data-responsive` (the per-viewport variant
  // CHOICE) above — a Scroll Variant never drives the canvas display. The scroll `from`/`to` is
  // morph context only; the runtime morph wins because the withResponsiveProps HOC skips
  // `initialVariant` from its merge when `data-scroll-variant` is present.

  // Forwarded-prop substitution on nested instance wrappers.
  //
  // Each nested instance inside the master file (e.g. `<RoHuVu poon={poon2}/>`
  // inside UxTaPa.tsx) has `attrPropRefs.poon = 'poon2'` recorded by the
  // parser, and `attrs.poon` pre-resolved to the master's own default for
  // `poon2`. When the OUTER instance (UxTaPa on a page) was invoked with
  // its own `poon2=…` attr, that runtime value has to flow down into the
  // nested instance's `attrs.poon` — otherwise the next expansion pass
  // for RoHuVu sees only the master's default and the page-level
  // override is lost. This is the canvas equivalent of React's prop-
  // forwarding chain at runtime.
  //
  // No-op when the outer instance didn't override the ref'd name —
  // nested attr keeps the master default and the master-canvas
  // rendering still shows the inheritance correctly.
  // `instanceProps` (attrs + componentProps), NOT just `attrs` — a template/route var BAKED into a forwarded
  // prop on the canvas (`<Header baPoWeVariant={baPoWeVariant}>` → `baPoWeVariant={"variant-7"}` via
  // substituteTemplateVarAttrsForCanvas) lands in componentProps (an expression literal), not attrs. Reading
  // only attrs missed it, so a forwarded variant var set via the Template tool never reached the nested
  // instance on the canvas (the BaPoWe/Logo Mark kept its master default — black — while live rendered white).
  if (Object.keys(instanceProps).length > 0) {
    const stripQ = (s: string) => s.replace(/^["'](.*)["']$/s, '$1');
    for (const node of componentNodes.values()) {
      if (node.attrPropRefs) {
        if (!node.attrs) node.attrs = {};
        for (const [attrName, refName] of Object.entries(node.attrPropRefs)) {
          if (!(refName in instanceProps)) continue;
          node.attrs[attrName] = instanceProps[refName];
        }
      }
      // PER-PARENT-VARIANT CONDITIONAL `initialVariant` — the nested instance's variant depends on the OUTER
      // (e.g. Header) variant: `variant === 'variant-6' ? baPoWeVariant : … : 'default'`.
      //   (1) Resolve EVERY VARIABLE branch (attrConditionalVarRefs) against the OUTER instance's prop value
      //       (route/forward override) ?? the baked @pageVariables default, IN PLACE on attrConditional — so
      //       the canvas's per-parent-variant remap (perParentOverrides), which fires when the OUTER variant
      //       differs PER VIEWPORT (a scroll-variant Header is variant-6 on desktop, mobile on tablet), shows
      //       the overridden child variant on every tile that lands on a variable branch.
      //   (2) Bake the branch for the OUTER instance's OWN resolved variant onto attrs.initialVariant (drives
      //       the primary tile's componentVariant). Use `attrInitialVariant` — NOT instanceProps.initialVariant
      //       — it's the RESOLVED outer variant (accounts for a scroll-variant canvasVariant / data-responsive
      //       that a runtime `initialVariant={state}` binding hides from attrs; the prior bug: outerVariant was
      //       null for a scroll-variant Header → this block skipped → the canvas used the baked page-var
      //       default instead of the route override).
      const cond = node.attrConditional?.initialVariant;
      if (cond) {
        const varRefs = node.attrConditionalVarRefs?.initialVariant;
        if (varRefs) {
          for (const [bk, refName] of Object.entries(varRefs)) {
            if (refName in instanceProps) cond[bk] = stripQ(instanceProps[refName]);
          }
        }
        const ov = attrInitialVariant ?? instanceProps.initialVariant ?? null;
        if (ov != null) {
          const branchKey = (ov in cond) ? ov : 'default';
          if (cond[branchKey] != null) { if (!node.attrs) node.attrs = {}; node.attrs.initialVariant = cond[branchKey]; }
        }
      }
      // PER-VARIANT STYLE VARIABLE in a variant OBJECT (`logoNameVariants['variant-6'] = { color: color }`) —
      // the idiomatic framer-motion shape. The parser resolved it to the prop DEFAULT (motionVariants) and
      // recorded the prop (motionVariantVariables). Override with the INSTANCE's prop value (route/forward) so
      // a PAGE renders the per-page color. CLONE the variant entry (motionVariants is shared with the cached
      // master node — never mutate the entry object in place).
      const mvv = node.motionVariantVariables;
      if (mvv && node.motionVariants) {
        for (const [vName, propMap] of Object.entries(mvv)) {
          for (const [cssProp, refName] of Object.entries(propMap)) {
            if (!(refName in instanceProps)) continue;
            node.motionVariants[vName] = { ...(node.motionVariants[vName] ?? {}), [cssProp]: stripQ(instanceProps[refName]) };
          }
        }
      }
    }
  }

  // CMS COMPONENT (Mechanism A) — CANVAS resolution. When the INSTANCE binds a prop
  // to a collection field (`<Card content={item.title}/>` → instanceNode.propBindings),
  // the value is neither a static attr nor a componentProp, so the override pass above
  // never surfaces it — the master node keeps its DEFAULT for every ghost. Propagate the
  // binding onto the master node that USES the prop, as a real text/style/attr binding;
  // the ghost renderer (applyBindingsToGhost) then resolves it per collection item. The
  // markers come from the master parse: text `{prop}` → node.textVariable; style
  // `{{ cssProp: prop }}` → node.styleVariables[cssProp]; attr `src={prop}` → attrPropRefs.
  // (Live already works — real React passes `item.title` through the prop.)
  // PER-VIEWPORT CMS rebindings (responsive). Build BEFORE the base-binding pass
  // below deletes `node.textVariable`. The set of CMS-bound props = base bindings
  // (`item.field`) ∪ per-viewport field-refs; non-CMS responsive props (gap, …)
  // are excluded so they keep flowing through responsivePropStyles.
  const respFieldBindings = instanceNode.responsivePropFieldBindings;
  if (respFieldBindings || responsiveProps) {
    const cmsProps = new Set<string>();
    if (instanceNode.propBindings) for (const b of instanceNode.propBindings) cmsProps.add(b.prop);
    if (respFieldBindings) for (const vp of Object.values(respFieldBindings)) for (const p of Object.keys(vp)) cmsProps.add(p);
    for (const node of componentNodes.values()) {
      const rb = lowerResponsiveBindings(node, cmsProps, respFieldBindings, responsiveProps);
      if (rb) node.responsiveBindings = rb;
    }
  }

  if (instanceNode.propBindings?.length) {
    for (const { prop, field } of instanceNode.propBindings) {
      for (const node of componentNodes.values()) {
        if (node.textVariable === prop) {
          node.binding = { field, property: 'text' };
          delete node.textVariable;   // now a CMS binding, not a static prop default
        }
        if (node.styleVariables) {
          for (const [cssProp, pName] of Object.entries(node.styleVariables)) {
            if (pName !== prop) continue;
            if (!node.styleBindings) node.styleBindings = [];
            if (!node.styleBindings.some(b => b.styleProp === cssProp)) {
              node.styleBindings.push({ styleProp: cssProp, field });
            }
          }
        }
        if (node.attrPropRefs) {
          for (const [attrName, refName] of Object.entries(node.attrPropRefs)) {
            if (refName !== prop) continue;
            if (attrName !== 'src' && attrName !== 'href' && attrName !== 'alt') continue;
            if (!node.attrBindings) node.attrBindings = [];
            if (!node.attrBindings.some(b => b.property === attrName)) {
              node.attrBindings.push({ field, property: attrName as 'src' | 'href' | 'alt' });
            }
          }
        }
      }
    }
  }

  // Find root nodes in the component (nodes without parents).
  // EXCLUDE canvas-node roots (`isCanvasNode: true`) — those come from
  // `canvasNodes` fragment children or hoisted `const cn_<id> = …` slot
  // declarations in the master file. They're free-floating on the master
  // canvas, not part of the component's rendered tree, and must not be
  // attached as children of the instance node on a consuming page —
  // attaching them pulls their absolute workspace coords into the
  // instance's content bounds and pollutes the auto-computed dimensions
  // (visible symptom: an instance whose intrinsic size is the size of a
  // slot canvas-node, e.g. 227×185, instead of the master root's 940×483).
  // Slot wiring happens via CodeComponentHost reading the component
  // file's slot connections — the canvas-nodes don't need to live in the
  // instance subtree to be resolvable.
  const rootNodes: CanvasNode[] = [];
  for (const [, node] of componentNodes) {
    // Overlay nodes are portal-rendered, not component roots — never expand an
    // instance around one (see the variant-root skip above).
    if (!node.parentId && !node.isCanvasNode && !node.attrs?.['data-overlay']) rootNodes.push(node);
  }

  // Mark all component nodes with boundary metadata
  for (const [nodeId, node] of componentNodes) {
    // Prefix node IDs to avoid collisions: "instanceId:componentNodeId"
    const prefixedId = `${instanceNode.id}:${nodeId}`;

    const isRoot = rootNodes.includes(node);

    // Update parent references with prefix
    // - regular children: prefix the parent id
    // - non-canvas roots: become children of the instance node
    // - canvas-node roots (slot consts / canvasNodes fragment): keep
    //   parentId null — they're not children of the instance (see the
    //   rootNodes filter above for why); a stray `instanceNode.id` here
    //   would create an asymmetric edge (parent says instance but
    //   instance doesn't list them as children).
    const prefixedParentId = node.parentId
      ? `${instanceNode.id}:${node.parentId}`
      : (node.isCanvasNode ? null : instanceNode.id);

    const prefixedChildren = node.children.map(childId => `${instanceNode.id}:${childId}`);

    // Apply prop→style + prop→text overrides from instance attrs.
    // The same instance attr can drive a style value (`color: color`) or
    // text content (`{title}`); resolveInstancePropOverrides returns one
    // entry per usage with a `kind` discriminator.
    let overriddenStyles = node.styles;
    let overriddenTextContent: string | null = null;
    if (propStyleOverrides.size > 0) {
      const styleOverrides: Record<string, string> = {};
      for (const [, override] of propStyleOverrides) {
        if (override.nodeId !== nodeId) continue;
        if (override.kind === 'style') {
          styleOverrides[override.cssProp] = override.value;
        } else if (override.kind === 'text') {
          overriddenTextContent = override.value;
        }
      }
      if (Object.keys(styleOverrides).length > 0) {
        overriddenStyles = { ...node.styles, ...styleOverrides };
      }
    }

    // Apply DEFAULT-parent-variant child variant styles: if the instance picks
    // a non-default child variant on the parent's primary (or via plain
    // initialVariant), merge those styles into the expanded base. Per-parent
    // overrides are handled below by remapping motionVariants.
    if (defaultChildVariant && defaultChildVariant !== 'default' && node.motionVariants) {
      const variantStyles = node.motionVariants[defaultChildVariant];
      if (variantStyles) {
        overriddenStyles = { ...overriddenStyles, ...variantStyles };
      }
    }

    // For root nodes: strip master-page-only positioning before merging instance
    // styles. buildComponentFile forces position:absolute on the master root so
    // cards can be placed freely on the master canvas; on an INSTANCE that's
    // wrong because the wrapping instance node has no positioned ancestor —
    // width:100% / height:100% then resolve against a far ancestor and balloon.
    // For instance use the root flows naturally inside its wrapper.
    if (isRoot) {
      const rootKeysToStrip: Array<keyof typeof overriddenStyles> = ['position', 'left', 'top', 'right', 'bottom'];
      let needsStrip = false;
      for (const k of rootKeysToStrip) {
        if (overriddenStyles[k as string] !== undefined) { needsStrip = true; break; }
      }
      if (needsStrip) {
        overriddenStyles = { ...overriddenStyles };
        for (const k of rootKeysToStrip) delete (overriddenStyles as any)[k];
      }
    }
    // For root nodes: merge instance tag's own inline styles onto the root,
    // EXCLUDING wrapper-only props (position, left/top/right/bottom, transform,
    // order, flex, grid placement, margin, alignSelf/justifySelf). Those describe
    // how the *instance* sits inside its parent on canvas — they belong on the
    // outer instance wrapper. Forwarding them to the root would double-apply
    // the positioning (root ends up at left/top relative to the wrapper, which
    // is already at the same left/top in its parent) and collapse the layout.
    // Width/height/padding/background/borderRadius/etc. are the user's actual
    // visual customizations of the component and DO flow onto the root via
    // {...style} the same way React does in production.
    if (isRoot && instanceNode.styles && Object.keys(instanceNode.styles).length > 0) {
      // When the instance is hidden per variant — via AnimatePresence
      // (`hiddenOnVariants`) or a `display` ternary (`conditionalStyles.display`)
      // — visibility is the WRAPPER's job. `instanceNode.styles.display` here is
      // the resolved DEFAULT branch (e.g. `'none'` when hidden on default), and
      // baking it onto the root would hide the instance on EVERY variant (the
      // per-variant data lives on the wrapper, not the root). Skip `display`.
      const instHasVisibilityControl =
        !!(instanceNode.hiddenOnVariants && instanceNode.hiddenOnVariants.size > 0) ||
        !!(instanceNode.conditionalStyles && instanceNode.conditionalStyles['display']);
      const instanceStylesForRoot: Record<string, string> = {};
      for (const [k, v] of Object.entries(instanceNode.styles)) {
        if (WRAPPER_ONLY_STYLE_PROPS.has(k)) continue;
        if (k === 'display' && instHasVisibilityControl) continue;
        instanceStylesForRoot[k] = v;
      }
      if (Object.keys(instanceStylesForRoot).length > 0) {
        overriddenStyles = { ...overriddenStyles, ...instanceStylesForRoot };
      }
    }

    // Prefix collectionList templateIds if present (so Renderer can find them)
    let prefixedCollectionList = node.collectionList;
    if (node.collectionList) {
      const prefixedTemplateIds: Record<string, string> = {};
      for (const [key, val] of Object.entries(node.collectionList.templateIds)) {
        prefixedTemplateIds[key] = `${instanceNode.id}:${val}`;
      }
      prefixedCollectionList = { ...node.collectionList, templateIds: prefixedTemplateIds };
    }

    // Remap motionVariants by parent variant name. The Renderer keys variant
    // lookups off the PARENT viewport's variant name (e.g. 'variant-1'), so
    // motionVariants on the expanded child must answer for PARENT variants —
    // not the child's internal variant names. Without this remap, the canvas
    // would show the child's variant by accidental name match (parent
    // 'variant-1' viewport happens to look up child's 'variant-1' entry),
    // making per-parent independent choices impossible.
    //
    // - With per-parent overrides: keys = parent variant names, values =
    //   chosen child's variant style entries.
    // - With ONLY a plain initialVariant (or none): clear motionVariants —
    //   the chosen child variant is already baked into base styles, and we
    //   want every parent viewport to show that same baked-in result, not
    //   accidentally fall through to a name-matched child variant.
    let remappedMotionVariants = node.motionVariants;
    if (node.motionVariants) {
      if (Object.keys(perParentOverrides).length > 0) {
        remappedMotionVariants = {};
        for (const [parentVariant, childVariant] of Object.entries(perParentOverrides)) {
          const childStyles = node.motionVariants[childVariant];
          if (childStyles) {
            remappedMotionVariants[parentVariant] = childStyles;
          }
        }
      } else if (!respAttr && !(responsiveVariantMap && Object.keys(responsiveVariantMap).length > 0)) {
        // Parent-driven nested instance (NO own per-viewport switching) — clear
        // motionVariants so a parent variant never accidentally name-matches a
        // child variant. With a plain initialVariant the chosen child variant is
        // baked into base above; with NONE the child renders its own default.
        // (Bug before: the `defaultChildVariant`-only guard left motionVariants
        // intact when the instance had no initialVariant, so a parent
        // 'variant-1' tile rendered the child's 'variant-1' by name-match —
        // e.g. a nested frame turned red on the parent's 2nd variant while the
        // Variant select still read 'default'.)
        //
        // EXCEPTION (`responsiveVariantMap`): when THIS instance drives its OWN
        // variant per viewport — via `data-responsive` OR via the inline-ternary
        // per-viewport variant rail `initialVariant={__mqN ? var : base}` (which
        // also lands in `responsiveVariantMap`, lines 526+) — its motionVariants
        // MUST be kept (keyed by their own names) so resolveVariantStyles can apply
        // the right variant per breakpoint. Keying this guard on `respAttr` ALONE
        // (data-responsive) wrongly cleared them for the inline-ternary case, so a
        // StartTrialButton hoisted to variant-2 on tablet resolved 'variant-2' but
        // had no 'variant-2' entry → fell back to the baked default (black).
        remappedMotionVariants = {};
      }
    }

    // Mirror the runtime `__applyInstanceSize` (instance-size-override.ts) on the
    // CANVAS: an instance's explicit width/height overrides the variant size on
    // EVERY variant entry. Without this the variant's width (e.g. 586px on the
    // tablet variant) beats the instance's override (e.g. 97%) in
    // resolveVariantStyles (base + variant merge), so the canvas would disagree
    // with the live site — which DOES apply the override via __applyInstanceSize.
    if (isRoot && remappedMotionVariants && Object.keys(remappedMotionVariants).length > 0) {
      const instW = instanceNode.styles?.width;
      const instH = instanceNode.styles?.height;
      const hasW = !!instW && instW !== '';
      const hasH = !!instH && instH !== '';
      if (hasW || hasH) {
        const merged: Record<string, Record<string, string>> = {};
        for (const [vName, vStyles] of Object.entries(remappedMotionVariants)) {
          merged[vName] = {
            ...vStyles,
            ...(hasW ? { width: instW } : {}),
            ...(hasH ? { height: instH } : {}),
          };
        }
        remappedMotionVariants = merged;
      }
    }

    // Propagate responsiveVariantMap to NESTED instance wrappers too.
    // A nested-instance JSX tag like `<NestedComp …/>` has no motionVariants
    // of its own (it's a component reference, not a motion element), so the
    // legacy gate `node.motionVariants || node.conditionalStyles` left it
    // null. The next expansion pass then has nothing to inherit, and the
    // nested descendants render at default on every viewport. Stamping the
    // map on instance wrappers as well lets the inner expansion read it
    // and forward it onto its own descendants.
    //
    // `isComponentInstance` isn't set yet during this loop (it's stamped at
    // the end of each expansion pass), so detect by the PascalCase tag
    // shape — same heuristic the loop in parseProjectFile uses to find
    // expansion candidates.
    const isNestedInstanceWrapper = isComponentTag(node.type);
    // Also carry the map onto a conditionally-rendered (AnimatePresence) node that
    // has NO variant styles of its own — only `hiddenOnVariants`. On a page instance
    // its per-viewport visibility is resolved from responsiveVariantMap, so without
    // the map the canvas can't tell it's hidden on the active viewport's variant
    // (it'd show on every tile while the live site hides it).
    const shouldCarryResponsive = (node.motionVariants || node.conditionalStyles || isNestedInstanceWrapper || (node.hiddenOnVariants && node.hiddenOnVariants.size > 0) || !!node.variantBindings);

    // Propagate the instance's per-variant VISIBILITY onto the expanded ROOT —
    // the actually-rendered element. The instance WRAPPER carries
    // `hiddenOnVariants` (AnimatePresence) / `conditionalStyles.display` (a
    // display ternary), but the rendered subtree is the root. We already skip
    // baking a static `display` onto it (above), so without carrying the
    // per-variant data here the instance would show on EVERY variant — the
    // reported "I hid it but it's still there" bug.
    let rootHidden = node.hiddenOnVariants;
    let rootConditional = node.conditionalStyles;
    if (isRoot) {
      if (instanceNode.hiddenOnVariants && instanceNode.hiddenOnVariants.size > 0) {
        rootHidden = new Set([...(node.hiddenOnVariants ?? []), ...instanceNode.hiddenOnVariants]);
      }
      if (instanceNode.conditionalStyles && instanceNode.conditionalStyles['display']) {
        rootConditional = { ...(node.conditionalStyles ?? {}), display: instanceNode.conditionalStyles['display'] };
      }
    }
    // Per-variant VARIABLE bindings (`<cssProp>: variant === 'v' ? prop : '…'`, incl. overlay `--X`):
    // conditionalStyles holds the master's resolved DEFAULT per variant, but an instance can pass its
    // OWN value for that prop (`<Comp zefzefze="133px"/>`). Swap the variant branch for the instance
    // attr value so the canvas resolves what the live site shows (live evaluates the prop at runtime).
    if (node.conditionalStyleVariables && instanceNode.attrs && Object.keys(instanceNode.attrs).length > 0) {
      for (const [cssProp, variantMap] of Object.entries(node.conditionalStyleVariables)) {
        // Only override REAL conditionalStyles keys — skip the overlay `border` MIRROR (the actual
        // style key is the `--X` custom prop, which is what conditionalStyles carries + the canvas applies).
        if (!node.conditionalStyles || !(cssProp in node.conditionalStyles)) continue;
        for (const [variant, propName] of Object.entries(variantMap)) {
          const v = instanceNode.attrs[propName];
          if (v === undefined) continue;
          // Clone before mutating so we never write through to the shared master node.conditionalStyles.
          const cloned: Record<string, Record<string, string>> =
            rootConditional && rootConditional !== node.conditionalStyles ? rootConditional : { ...node.conditionalStyles };
          rootConditional = cloned;
          cloned[cssProp] = { ...(cloned[cssProp] ?? {}), [variant]: v };
        }
      }
    }
    // BAKE the active variant's conditional values into the static styles. A plain
    // `initialVariant="variant-1"` instance (no data-responsive) is baked, not resolved per-viewport,
    // so the Renderer's resolveVariantStyles never applies conditionalStyles (it needs a resolvedVariant).
    // Bake `conditionalStyles[cssProp][attrInitialVariant]` so the canvas matches live. (data-responsive
    // instances still resolve per-viewport at render; this is idempotent for the primary.)
    if (attrInitialVariant && attrInitialVariant !== 'default' && rootConditional) {
      for (const [cssProp, branches] of Object.entries(rootConditional)) {
        const val = (branches as Record<string, string>)[attrInitialVariant];
        if (val !== undefined) overriddenStyles = { ...overriddenStyles, [cssProp]: val };
      }
    }

    // BAKE static visibility when the instance has NO variant context at all
    // (no data-responsive, no inherited map). The Renderer's hiddenOnVariants
    // check needs a resolvedVariant, and with no map none ever resolves on a
    // page tile — so every conditionally-rendered (AnimatePresence) subtree
    // painted at once (live find 2026-06-10: a tabs component's three panels
    // overlapped on the canvas while the live site showed only the active
    // tab). The effective static variant is the instance's pick (baked above)
    // or the component default; nodes hidden there get display:'none' baked
    // into base, and the master-internal set is dropped (visibility is static
    // without per-viewport switching). Instance-level (parent-keyed) sets
    // merged onto the root are kept — the parent master resolves those.
    let bakedHidden = rootHidden;
    if (!responsiveVariantMap && node.hiddenOnVariants && node.hiddenOnVariants.size > 0) {
      const effectiveVariant = defaultChildVariant ?? 'default';
      if (node.hiddenOnVariants.has(effectiveVariant)) {
        overriddenStyles = { ...overriddenStyles, display: 'none' };
      }
      bakedHidden = isRoot && instanceNode.hiddenOnVariants && instanceNode.hiddenOnVariants.size > 0
        ? new Set(instanceNode.hiddenOnVariants)
        : undefined;
    }

    // PER-PARENT-VARIANT REMAP for conditionalStyles + hiddenOnVariants — the
    // motionVariants remap above already answers for PARENT variant names, but
    // LAYOUT props (flexDirection / gap / order …) live as inline ternaries in
    // `conditionalStyles` and visibility lives in `hiddenOnVariants`, both
    // keyed by the CHILD's own variant names. Inside a master, tiles resolve
    // with the PARENT variant name — so a nested instance mapped to its
    // responsive variant per parent tile (`initialVariant={initialVariant ===
    // 'variant-1' ? 'variant-4' : …}`) kept rendering the child's DEFAULT
    // layout (the row) on the canvas while the live preview correctly showed
    // the column (user report 2026-07-28). No 'default' key is emitted on
    // purpose: the default-child branch is already baked into base styles
    // (attrs.initialVariant carries the ternary's else branch), and
    // resolveVariantStyles falls back base-ward when a variant key is absent.
    let remappedConditional = rootConditional;
    let remappedHidden = bakedHidden;
    if (Object.keys(perParentOverrides).length > 0) {
      if (rootConditional) {
        const rc: Record<string, Record<string, string>> = {};
        for (const [prop, branches] of Object.entries(rootConditional)) {
          const nb: Record<string, string> = {};
          for (const [pv, cv] of Object.entries(perParentOverrides)) {
            const v = (branches as Record<string, string>)[cv] ?? (branches as Record<string, string>)['default'];
            if (v !== undefined) nb[pv] = v;
          }
          if (Object.keys(nb).length > 0) rc[prop] = nb;
        }
        remappedConditional = Object.keys(rc).length > 0 ? rc : null;
        trace.action('project-parser:remap-conditional-by-parent', {
          instanceId: instanceNode.id, nodeId: prefixedId, props: Object.keys(rc),
        });
      }
      const childHidden = node.hiddenOnVariants;
      if (childHidden && childHidden.size > 0) {
        const hs = new Set<string>();
        for (const [pv, cv] of Object.entries(perParentOverrides)) {
          if (childHidden.has(cv)) hs.add(pv);
        }
        if (childHidden.has(defaultChildVariant ?? 'default')) hs.add('default');
        if (isRoot && instanceNode.hiddenOnVariants) {
          for (const v of instanceNode.hiddenOnVariants) hs.add(v);
        }
        remappedHidden = hs.size > 0 ? hs : undefined;
      }
    }

    allNodes.set(prefixedId, {
      ...node,
      id: prefixedId,
      parentId: prefixedParentId,
      children: prefixedChildren,
      styles: overriddenStyles,
      hiddenOnVariants: remappedHidden,
      conditionalStyles: remappedConditional,
      motionVariants: remappedMotionVariants,
      // Instance attr value wins over the master's resolved default text.
      // Production React does this naturally via prop passing — `<p>{title}</p>`
      // renders whatever `title` is on the parent. The parser has to do it
      // manually here because expansion already resolved `{title}` into the
      // master's default at parse time.
      textContent: overriddenTextContent !== null ? overriddenTextContent : node.textContent,
      componentFile: componentInfo.filePath,
      componentInstanceId: instanceNode.id,
      isComponentRoot: isRoot,
      responsiveVariantMap: shouldCarryResponsive ? responsiveVariantMap : null,
      responsiveVariantBp: shouldCarryResponsive ? responsiveVariantBp : null,
      // The instance's active variant — so the Renderer resolves per-variant CMS
      // bindings (variantBindings) on this page instance even though there's no
      // variant artboard (variantName is null on a page). Mirrors how the active
      // variant's STYLES are already baked above. Null on the primary/default.
      componentVariant: initialVariant ?? null,
      // Lower this node's per-viewport PROP overrides to the styles they drive. `node` is
      // the master node — its `styleVariables` (cssProp → propName) tells us which CSS prop
      // each variable controls (e.g. flexDirection ← direction). The canvas then resolves
      // them per replica in resolveVariantStyles. Per-instance (prefixed node), so no leak.
      responsivePropStyles: lowerResponsivePropsToStyles(node.styleVariables, responsiveProps),
      // Per-viewport CMS rebindings (field-ref / unbind→default), resolved per
      // ghost in the Renderer (resolveBoundField). Built in the pass above.
      responsiveBindings: node.responsiveBindings,
      collectionList: prefixedCollectionList,
      // The carried <style> CSS (overlay borders etc.) is one block covering
      // the whole expansion; attach it to the ROOT only so the Renderer injects
      // it once per instance. Selectors are already prefixed-id rewritten above.
      afterCSS: isRoot && instanceAfterCSS ? instanceAfterCSS : undefined,
    });

    // Add root component nodes as children of the instance node
    if (isRoot) {
      instanceNode.children.push(prefixedId);
    }
  }

  // Mark the instance node — componentFile points to the COMPONENT file (for double-click to enter)
  instanceNode.componentFile = componentInfo.filePath;
  // `isComponentInstance` is the source of truth for "this node is an
  // instance-tag wrapper for its own component". Setting it here regardless
  // of nesting depth fixes a bug where `<Outer><Inner/></Outer>` left the
  // Inner wrapper unrecognised — the Outer expansion stamped it with
  // `componentInstanceId` (correct: it lives inside Outer's expansion),
  // and the Renderer's wrapper detector required `!componentInstanceId`
  // so it skipped the wrapper-only style filtering and the
  // sizing-from-master fallback. The Inner master root then had its
  // width/height stripped without anywhere to fall back to and the
  // element collapsed to 0×0.
  instanceNode.isComponentInstance = true;
  // Preserve data-name from the instance tag if set (user-given name), otherwise use registry name
  if (!instanceNode.name) instanceNode.name = componentInfo.name;

  trace.action('project-parser:expand-component', {
    component: componentInfo.name,
    instanceId: instanceNode.id,
    expandedNodes: componentNodes.size,
  });
}

/**
 * Resolve instance prop overrides by scanning the component code for prop→style mappings.
 *
 * Given instance attrs { spoOnO: '89px' } and component code containing:
 *   style={{ gap: spoOnO }}
 * Returns a map: key=propName → { nodeId, cssProp, value }
 *
 * This simulates React's prop passing: the instance overrides the component's default.
 */
export type PropOverride =
  | { kind: 'style'; nodeId: string; cssProp: string; value: string }
  | { kind: 'text'; nodeId: string; value: string };

// Exported so the TEMPLATE layout-merge (store.ts) can resolve a page's
// @templateProps onto the merged layout nodes the SAME way a component instance
// resolves its props onto the expanded master — a template IS a component.
export function resolveInstancePropOverrides(
  instanceAttrs: Record<string, string>,
  componentCode: string,
): Map<string, PropOverride> {
  const result = new Map<string, PropOverride>();

  const propNames = Object.keys(instanceAttrs);
  if (propNames.length === 0) return result;

  // For each prop passed on the instance, find where it's used in the
  // component's source — both as a style value AND as a text expression
  // child. Both need to be overridden by the instance attr value.
  //   Style: `cssProp: propName` inside a `style={{ ... }}` block
  //   Text:  `{propName}` directly inside JSX children (text-content variable)
  // In both cases we need to know WHICH node (data-id) the binding belongs to.

  // Helper: find the data-id of the JSX element a binding lives on. The
  // binding is at `bindingIndex` in `componentCode`; we walk back to find
  // the LAST `data-id="..."` before that — that's the *closest* enclosing
  // element. A naïve regex `match()` returns the first occurrence, which on
  // nested elements gives the parent's id and breaks overrides.
  const findEnclosingDataId = (bindingIndex: number): string | null => {
    const before = componentCode.slice(0, bindingIndex);
    const matches = [...before.matchAll(/data-id="([^"]*)"/g)];
    if (matches.length === 0) return null;
    return matches[matches.length - 1][1];
  };

  for (const propName of propNames) {
    const propValue = instanceAttrs[propName];

    // ── Style usage: `cssProp: propName` ──
    // The lookahead requires the VALUE to END after the prop (`,` or `}`, allowing trailing space) so
    // a ternary TEST (`cssProp: initialVariant === 'v' ? … : …`) doesn't false-match as a direct
    // binding — `(?=[,\s}])` used to match the space before `===` and wrongly mapped cssProp → the
    // prop's attr value. Per-variant variable ternaries are handled via conditionalStyles instead.
    const styleRegex = new RegExp(`(\\w+):\\s*${propName}(?=\\s*[,}])`, 'g');
    let match;
    while ((match = styleRegex.exec(componentCode)) !== null) {
      const cssProp = match[1];
      const nodeId = findEnclosingDataId(match.index);
      if (nodeId) {
        result.set(`${propName}:${nodeId}`, { kind: 'style', nodeId, cssProp, value: propValue });
      }
    }

    // ── Style usage: BOOLEAN CONDITIONAL `cssProp: propName ? 'A' : 'B'` ──
    // Toggle variables (Hide → display, Wrap → flexWrap) bind through a ternary, not a bare identifier.
    // Resolve it to the branch the instance's boolean value selects ('true' → A, else → B) so the canvas
    // matches what real React renders for `prop={true}`.
    const condRegex = new RegExp(`(\\w+):\\s*${propName}\\s*\\?\\s*['"]([^'"]*)['"]\\s*:\\s*['"]([^'"]*)['"]`, 'g');
    let condMatch;
    while ((condMatch = condRegex.exec(componentCode)) !== null) {
      const cssProp = condMatch[1];
      // Match what `prop ? A : B` actually evaluates to on the live site (JS truthiness) — NOT a strict
      // `=== 'true'`. A hoisted toggle bound to a VARIABLE can resolve to a non-'true' truthy value (a
      // route value like 'none' for Hide, 'yes', etc.). Canonical truthiness lives in value-eval.isTruthy.
      const resolved = isTruthy(propValue) ? condMatch[2] : condMatch[3];
      const nodeId = findEnclosingDataId(condMatch.index);
      if (nodeId) {
        result.set(`${propName}:${nodeId}`, { kind: 'style', nodeId, cssProp, value: resolved });
      }
    }

    // ── Style usage: CUSTOM PROPERTY binding `"--X": propName` ──
    // The `\w+` form above can't match a custom-property key — it's quoted and
    // hyphenated (`"--zefzef": zefzef`). Overlay-border variables bind through
    // exactly this shape: the prop drives a `--X` custom property on the root,
    // and the `::after` rule consumes it via `border: var(--X)`. Capture the
    // FULL `--X` token as the cssProp so expandComponent writes the instance's
    // value onto the expanded root's `--X` (so `var(--X)` in the carried
    // `::after` resolves to the instance value, not the master default `""`).
    const customPropRegex = new RegExp(`["']?(--[\\w-]+)["']?\\s*:\\s*${propName}(?=\\s*[,}])`, 'g');
    let cpMatch;
    while ((cpMatch = customPropRegex.exec(componentCode)) !== null) {
      const cssProp = cpMatch[1]; // e.g. '--zefzef' — kept verbatim (custom props are case-sensitive)
      const nodeId = findEnclosingDataId(cpMatch.index);
      if (nodeId) {
        result.set(`${propName}:${nodeId}:${cssProp}`, { kind: 'style', nodeId, cssProp, value: propValue });
      }
    }

    // ── Style usage: SHORTHAND `style={{ propName, ... }}` ──
    // Babel-style shorthand object property — the master file uses
    // `{ transform }` to mean `{ transform: transform }`. The explicit-
    // form regex above misses these because there's no colon to match
    // against. Require a `{` or `,` immediately before (object-position)
    // and `,`, whitespace, or `}` immediately after — same boundary
    // semantics the colon-form uses, just without the key/value glue.
    // Skip the match when there's also an explicit-form override for
    // the same (propName, nodeId) pair already in `result` (the colon
    // form is more specific and should win).
    const shorthandRegex = new RegExp(`(?<=[{,]\\s*)\\b${propName}(?=[,\\s}])`, 'g');
    let shortMatch;
    while ((shortMatch = shorthandRegex.exec(componentCode)) !== null) {
      const nodeId = findEnclosingDataId(shortMatch.index);
      if (!nodeId) continue;
      const key = `${propName}:${nodeId}`;
      if (result.has(key)) continue; // explicit form already won
      // For shorthand, cssProp === propName by definition.
      result.set(key, { kind: 'style', nodeId, cssProp: propName, value: propValue });
    }

    // ── Text usage: `{propName}` as a JSX child ──
    // Match a brace-wrapped Identifier that appears inside a JSX children
    // position — preceded eventually by `>` (closing of an opening tag) and
    // followed eventually by `<` (the closing tag start). Reject matches
    // inside `style={{ ... }}` by requiring the immediate-prior context not
    // to be a `:` (style key/value separator) or `,` (style entry separator).
    const textRegex = new RegExp(`\\{\\s*${propName}\\s*\\}`, 'g');
    let textMatch;
    while ((textMatch = textRegex.exec(componentCode)) !== null) {
      // Quick guard: skip when the brace is part of a style object — the
      // char immediately before `{` is `:` (style value position) or the
      // `{` itself is the inner brace of `{{`.
      const charBefore = componentCode.charAt(textMatch.index - 1);
      const twoBefore = componentCode.charAt(textMatch.index - 2);
      if (charBefore === ':' || charBefore === ',' || (charBefore === '{' && twoBefore !== '>')) {
        continue;
      }
      // Must be inside JSX children: nearest non-whitespace char before the
      // `{` should be `>` (end of opening tag) — otherwise it's an
      // expression somewhere else (like a prop value `prop={propName}`).
      let i = textMatch.index - 1;
      while (i >= 0 && /\s/.test(componentCode.charAt(i))) i--;
      if (componentCode.charAt(i) !== '>') continue;

      const nodeId = findEnclosingDataId(textMatch.index);
      if (nodeId) {
        // Use a `text:` prefixed key so it doesn't collide with style overrides
        // for the same nodeId (rare but possible if a prop drives both).
        result.set(`text:${propName}:${nodeId}`, { kind: 'text', nodeId, value: propValue });
      }
    }
  }

  if (result.size > 0) {
    trace.fn('resolveInstancePropOverrides', {
      propCount: propNames.length,
      overrideCount: result.size,
      overrides: [...result.entries()].map(([k, v]) =>
        v.kind === 'style' ? `${k} → ${v.cssProp}: ${v.value}` : `${k} → text: ${v.value}`,
      ),
    });
  }

  return result;
}

/** Check if a tag name looks like a component (starts with uppercase) */
function isComponentTag(tagName: string): boolean {
  return tagName.length > 0 && tagName[0] === tagName[0].toUpperCase() && tagName[0] !== tagName[0].toLowerCase();
}
