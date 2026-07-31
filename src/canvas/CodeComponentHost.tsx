// CodeComponentHost.tsx — Mounts live React components for Code component nodes on the canvas.
// Watches nodesAtom for Code component instances, compiles their source, and renders them.

import { useEffect, useRef, useCallback, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { nodesAtom, codeAtom } from '@/code/stores/store';
import { coerceScalar } from '@/code/values/value-eval';
import { projectFS } from '@/code/project/project-fs';
import { compileCodeComponent, clearCodeComponentCache } from './code-component-runtime';
import { createRoot, type Root } from 'react-dom/client';
import React from 'react';
import { trace } from '@/shared/debug-trace';
import { getContentRoot } from '@/canvas/node-ops';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { getViewportWidths } from '@/code/stores/viewport-store';
import type { CanvasNode } from '@/code/parsing/parser';
import { WRAPPER_ONLY_STYLE_PROPS } from '@/shared/constants';
import { serializeSlotChildren } from './slot-children';
import { getAllSlotConnections } from '@/code/generation/slot-ops';

import { getCdnComponent, loadCdnComponent } from '@/cloud/components/cdn-component-cache';

/**
 * CodeComponentHost — mounts live React components for Code component nodes on the canvas.
 * Watches nodesAtom for Code component instances, compiles their source, and renders them.
 */
/** Coerce string prop values to JS types ("true"→true, "42"→42, "16px" stays a string).
 *  Canonical logic in value-eval.coerceScalar (shared with the sandbox's coerceProps). */
function coerceValue(value: string): any {
  return coerceScalar(value);
}

/** Extract props from node attrs + componentProps, coercing values. */
export function extractCodeComponentProps(node: CanvasNode): Record<string, any> {
  const props: Record<string, any> = {};
  if (node.attrs) {
    for (const [key, value] of Object.entries(node.attrs)) {
      // Skip most data-* attrs, but pass data-responsive through (per-viewport prop overrides)
      if (key === 'data-responsive') {
        props[key] = value;
        continue;
      }
      if (key.startsWith('data-') || key === 'style' || key === 'className') continue;
      props[key] = coerceValue(value);
    }
  }
  if (node.componentProps) {
    for (const [key, value] of Object.entries(node.componentProps)) {
      props[key] = coerceValue(value);
    }
  }
  // Bake INLINE per-viewport variable VALUES into `data-responsive` so the code component resolves the
  // per-tile value on canvas. A per-viewport variable bound on a replica is written as an inline ternary
  // `prop={__mq ? var : base}` (the same mechanism design-component props use); the parser resolves its value
  // into `responsiveAttrPropValues`, NOT into data-responsive. extractCodeComponentProps only forwards data-responsive
  // (literal overrides) — so without this an inline-ternary per-viewport VARIABLE was invisible to the
  // component and EVERY tile got the BASE value. Live resolves the ternary via React (per __mq), which is why
  // it only broke on canvas. Don't clobber an explicit data-responsive literal already set for that width/prop.
  const rav = node.responsiveAttrPropValues;
  if (rav && Object.keys(rav).length > 0) {
    let dr: Record<string, any> = {};
    if (typeof props['data-responsive'] === 'string') {
      try { dr = JSON.parse(props['data-responsive']); } catch { dr = {}; }
    }
    for (const [prop, byWidth] of Object.entries(rav)) {
      for (const [wStr, val] of Object.entries(byWidth as Record<string, string>)) {
        if (!dr[wStr]) dr[wStr] = {};
        if (dr[wStr][prop] === undefined) dr[wStr][prop] = coerceValue(val);
      }
    }
    if (!dr._bp) dr._bp = Object.values(getViewportWidths()).map(Number).sort((a, b) => a - b);
    props['data-responsive'] = JSON.stringify(dr);
    trace.fn('code-component-host:bake-responsive-vars', { nodeId: node.id, props: Object.keys(rav) });
  }
  // Forward node.styles as a `style` prop so the code component's inner wrapper can
  // size itself the same way as in the live render. Without this, components
  // like MatrixRain that spread `...props.style` get nothing on canvas, their
  // inner wrapper collapses to auto-height, and the inner <canvas> with
  // `height: 100%` falls back to its 300×150 intrinsic size.
  //
  // Filter out canvas-positioning props (`position`, `left`, `top`,
  // `transform`, ...) that belong only on the outer Renderer wrapper —
  // passing them through to the inner element would double-position it.
  //
  // For URL-IMPORTED design components there's an EXTRA wrinkle: the
  // bundled source has the original designer's canvas-time positioning
  // (`position: absolute, left: 350px, top: 207px`) baked into the root
  // element's style. Those values offset the rendered component INSIDE
  // its wrapper, away from the wrapper's top-left, even when the
  // wrapper itself is positioned correctly. We append POSITION RESETS
  // to the forwarded style — `position: relative, left/top/right/bottom:
  // auto, transform: none` — that the bundle's `...style` spread at the
  // end of its inner style object will pick up and override the baked-in
  // canvas-time values with. Inner then flows naturally at (0,0) of the
  // wrapper, which is what every consumer wants.
  const isUrlImportedComponent = !!(node.componentFile && node.componentFile.startsWith('http'));
  if (node.styles) {
    const innerStyle: Record<string, string> = {};
    for (const [key, value] of Object.entries(node.styles)) {
      if (WRAPPER_ONLY_STYLE_PROPS.has(key)) continue;
      innerStyle[key] = value;
    }
    if (isUrlImportedComponent) {
      // Reset values are added EVEN when node.styles is empty, so a freshly
      // pasted instance with no explicit styles still gets the override.
      innerStyle.position = 'relative';
      innerStyle.left = 'auto';
      innerStyle.top = 'auto';
      innerStyle.right = 'auto';
      innerStyle.bottom = 'auto';
      innerStyle.transform = 'none';
    }
    if (Object.keys(innerStyle).length > 0) {
      props.style = innerStyle;
      trace.fn('code-component-host:forward-style', {
        nodeId: node.id,
        propCount: Object.keys(innerStyle).length,
        urlImported: isUrlImportedComponent,
      });
    }
  }
  return props;
}

/** Detect the viewport width for a container element by walking up to [data-viewport]. */
function getCanvasViewportWidth(el: HTMLElement): number | undefined {
  const vpRoot = el.closest('[data-viewport]') as HTMLElement | null;
  if (!vpRoot) return undefined;
  const vpId = vpRoot.getAttribute('data-viewport');
  if (!vpId) return undefined;
  const widths = getViewportWidths();
  return widths[vpId];
}

/** Walk up from node to find the nearest parent with an inline collection source. */
function findMapParent(node: CanvasNode, nodes: Map<string, CanvasNode>): CanvasNode | null {
  let mapParent = node.parentId ? nodes.get(node.parentId) ?? null : null;
  while (mapParent && !mapParent.collectionList?.source?.startsWith('__inline:')) {
    mapParent = mapParent.parentId ? nodes.get(mapParent.parentId) ?? null : null;
  }
  return mapParent;
}

// Module-level ref for direct Code component prop updates (bypass parse cycle for instant feedback)
let _codeComponentRoots: Map<string, { root: Root; component: string; propsHash: string }> | null = null;
let _codeComponentNodes: Map<string, CanvasNode> | null = null;

/**
 * Directly re-render Code component instances by data-id with updated props.
 * Called from ComponentPropsTool during drag for instant visual feedback.
 *
 * @param targetVpWidth — if set, only update the instance in that viewport (replica edit).
 *                        If undefined, update ALL instances (primary/base edit).
 */
export function renderCodeComponentDirect(
  codeComponentId: string,
  propOverrides: Record<string, any>,
  targetVpWidth?: number,
  /** Component-master VARIANT tile scope: fold the overrides into
   *  `__variantProps[prop][variant]` branches instead of the flat prop, so
   *  the sandbox's per-tile `resolveVariantProps` applies them ONLY on that
   *  variant's tile — a Hover-tile color drag must not repaint the primary
   *  and every other variant live (user report 2026-07-31; the COMMIT was
   *  already per-variant, only the drag preview leaked). */
  targetVariant?: string,
): void {
  if (!_codeComponentNodes) {
    trace.action('code-component-direct:no-refs', { hasNodes: !!_codeComponentNodes });
    return;
  }
  const node = _codeComponentNodes.get(codeComponentId);
  if (!node?.componentFile) {
    trace.action('code-component-direct:no-node', { codeComponentId, hasNode: !!node, componentFile: node?.componentFile });
    return;
  }
  trace.action('code-component-direct:start', { codeComponentId, componentFile: node.componentFile.slice(0, 60), propOverrides });

  // Merge baseProps from the node with the live overrides. Same merge as the
  // sandbox-side `mountCodeComponent` would do given fresh `node` props, so a
  // subsequent (committed) mount is a no-op for any overlapping prop.
  const baseProps = extractCodeComponentProps(node);
  // Carry per-variant style branches so the sandbox resolves the right size
  // per artboard tile (see the mount path) — a live prop edit on a master must
  // not collapse non-default tiles to the default-branch size.
  if (node.conditionalStyles && Object.keys(node.conditionalStyles).length > 0) {
    baseProps.__variantStyles = node.conditionalStyles;
  }
  if (node.attrConditional && Object.keys(node.attrConditional).length > 0) {
    baseProps.__variantProps = node.attrConditional;
  }
  let mergedProps: Record<string, any>;
  if (targetVariant && targetVariant !== 'default') {
    const vp: Record<string, Record<string, string>> = { ...((baseProps.__variantProps as Record<string, Record<string, string>>) ?? {}) };
    for (const [k, v] of Object.entries(propOverrides)) {
      vp[k] = { ...(vp[k] ?? {}), [targetVariant]: String(v) };
    }
    mergedProps = { ...baseProps, __variantProps: vp };
  } else {
    mergedProps = { ...baseProps, ...propOverrides };
  }

  // ─── Iframe path ─ canvas content lives in the cross-origin sandbox so
  // `document.querySelector` from the parent never finds the code component roots.
  // Forward to `updateCodeComponentProps` over the bridge — the sandbox's
  // mounted-roots map already contains the React root for this nodeId and
  // re-renders in place without recompiling the source. This is what makes
  // slider drag visually live (the parent never round-trips through Babel
  // during the drag; only on commit does `modifyProjectFile` fire once).
  {
    const bridge = getCanvasBridge();
    if ('updateCodeComponentProps' in bridge) {
      const pmBridge = bridge as any;
      const vpWidths = getViewportWidths();
      const desktopVp = vpWidths['desktop'] || 1440;
      // The sandbox iterates every replica root for this nodeId itself, so we
      // pass desktop width; per-replica vpWidth was stamped at mount time and
      // is preserved by the sandbox.
      pmBridge.updateCodeComponentProps(codeComponentId, mergedProps, targetVpWidth ?? desktopVp);
      trace.action('code-component-direct:bridge', { codeComponentId, overrideCount: Object.keys(propOverrides).length });
    }
  }

  // ─── Parent-frame path ─ legacy in-process renderer (kept as a fallback for
  // any deployment / test that runs without the iframe sandbox).
  //
  // Two source paths:
  //   • CDN (URL) → `getCdnComponent(url)` returns the already-loaded
  //     React component (dynamic-import result). If null, kick off
  //     `loadCdnComponent(url)` and skip this cycle — the cache fires
  //     `revyme:cdn-component-loaded` when ready and the next render
  //     pass picks it up.
  //   • Local TSX (projectFS) → unchanged. Read source, in-browser
  //     Babel compile via `compileCodeComponent`.
  if (_codeComponentRoots && _codeComponentRoots.size > 0) {
    let Component: React.ComponentType<any> | null = null;
    if (node.componentFile.startsWith('http')) {
      Component = getCdnComponent(node.componentFile) as React.ComponentType<any> | null;
      if (!Component) {
        void loadCdnComponent(node.componentFile);
      }
    } else {
      const componentCode = projectFS.readFile(node.componentFile);
      if (componentCode) {
        Component = compileCodeComponent(componentCode, node.type);
      }
    }
    if (Component) {
      for (const [rootKey, entry] of _codeComponentRoots) {
        const el = document.querySelector(`[data-node-id="${rootKey}"]`);
        if (!el) continue;
        const dataId = el.getAttribute('data-id');
        if (dataId !== codeComponentId) continue;
        const elVpWidth = getCanvasViewportWidth(el as HTMLElement);
        if (targetVpWidth !== undefined && elVpWidth !== targetVpWidth) continue;
        const localMerged: Record<string, any> = { ...mergedProps };
        if (elVpWidth !== undefined) localMerged.__canvasViewportWidth = elVpWidth;
        const propsHash = JSON.stringify(localMerged);
        entry.root.render(React.createElement(Component, localMerged));
        entry.propsHash = propsHash;
      }
    }
  }
}

export default function CodeComponentHost() {
  const nodes = useAtomValue(nodesAtom);
  const rootsRef = useRef<Map<string, { root: Root; component: string; propsHash: string }>>(new Map());
  // Tracks what we've already pushed to the sandbox per node so we can decide
  // between mount / re-mount / props-only update / skip on each sync pass.
  const sandboxMountStateRef = useRef<Map<string, { codeHash: string; propsHash: string }>>(new Map());
  // DEBOUNCED unmount: a page navigation makes `nodesAtom` briefly flip to another
  // page / an empty render (codeComponentCount drops 8→1→0), which would otherwise
  // unmount every code component then re-mount it a frame later — the "staggered /
  // flickering counters for ~2s on load" bug. We delay each unmount and CANCEL it
  // if the node reappears in the next sync, so a transient disappearance is a no-op.
  const pendingUnmountsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Keep module-level refs in sync for direct rendering
  _codeComponentRoots = rootsRef.current;
  _codeComponentNodes = nodes;

  // Extract sync logic so it can be called from effect AND from Renderer events
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  // Slot connections — `componentId → connected canvas-node ids`. Parsed
  // once per code change; the sync loop reads it via the ref.
  //
  // ALSO walks every design-component INSTANCE on the page, reads its
  // component file, and merges in that file's slot connections with the
  // instance's prefix (`${instanceId}:`) on both source and target. The
  // parser expands instances by prefixing every node id this way, so a
  // Marquee inside <KuBiYu data-id="frame-1" /> becomes
  // `frame-1:Marquee-X` in `nodes`. Its slot ref `{cn_canvas-X}` lives
  // only in KuBiYu's master file — not in the page code — so without
  // this merge the Marquee inside the instance never gets `__slotChildren`
  // and renders the placeholder ("Connect Content") on canvas even though
  // it composes fine on the live site (real JSX, identifiers resolve in
  // the component file's own scope).
  const code = useAtomValue(codeAtom);
  const slotConnections = useMemo(() => {
    const merged = new Map<string, string[]>(getAllSlotConnections(code));
    // Visit each top-level instance — `componentInstanceId == null` means
    // this IS the instance node, not one of its expanded children.
    for (const node of nodes.values()) {
      if (!node.isComponentInstance) continue;
      if (node.componentInstanceId) continue; // expanded child, skip
      const file = node.componentFile;
      if (!file || file.startsWith('http')) continue;
      const compCode = projectFS.readFile(file);
      if (!compCode) continue;
      const inner = getAllSlotConnections(compCode);
      for (const [compId, childIds] of inner) {
        const prefixedComp = node.id + ':' + compId;
        const prefixedChildren = childIds.map(c => node.id + ':' + c);
        // If the same prefixedComp already exists (rare — same instance
        // visited twice), concatenate so we don't lose either set.
        const existing = merged.get(prefixedComp);
        merged.set(prefixedComp, existing ? existing.concat(prefixedChildren) : prefixedChildren);
      }
    }
    return merged;
  }, [code, nodes]);
  const slotConnectionsRef = useRef(slotConnections);
  slotConnectionsRef.current = slotConnections;

  const syncCodeComponents = useCallback(() => {
    const nodes = nodesRef.current;
    const contentEl = getContentRoot();
    if (!contentEl) {
      trace.action('code-component-host:no-content-root');
      return;
    }

    // Find all Code component nodes
    const codeComponentNodes = [...nodes.values()].filter(n => n.isCodeComponent);
    trace.fn('code-component-host:sync', { codeComponentCount: codeComponentNodes.length, totalRoots: rootsRef.current.size });

    // Track which code components are still in the tree (unprefixed IDs)
    const activeCodeComponentIds = new Set(codeComponentNodes.map(n => n.id));

    // Unmount removed code components — rootsRef keys are viewport-prefixed (e.g. "tablet-reveal__1")
    // A key is active if its data-id part (without prefix/suffix) matches an active code component ID
    for (const [rootKey, entry] of rootsRef.current) {
      // Check if this root's DOM element still exists
      const el = document.querySelector(`[data-node-id="${rootKey}"]`);
      if (!el) {
        // DOM element gone — schedule unmount (use setTimeout to avoid React render conflict)
        setTimeout(() => { try { entry.root.unmount(); } catch { /* ignore */ } }, 0);
        rootsRef.current.delete(rootKey);
        trace.action('code-component-host:unmount', { nodeId: rootKey });
        continue;
      }
      // Check if the base code component ID is still in the tree
      const dataId = el.getAttribute('data-id') || rootKey;
      if (!activeCodeComponentIds.has(dataId)) {
        setTimeout(() => { try { entry.root.unmount(); } catch { /* ignore */ } }, 0);
        rootsRef.current.delete(rootKey);
        trace.action('code-component-host:unmount', { nodeId: rootKey });
      }
    }

    // Mount or update code components — find ALL instances across all viewports (desktop + replicas)
    for (const node of codeComponentNodes) {
      if (!node.componentFile) continue;

      // Find ALL container elements matching this Code component (desktop + replica viewports)
      // Non-ghost containers have data-id but NOT data-collection-ghost
      const allContainers = document.querySelectorAll(
        `[data-code-component="true"][data-id="${node.id}"]:not([data-collection-ghost])`
      );
      if (allContainers.length === 0) {
        trace.action('code-component-host:container-not-found', { nodeId: node.id, component: node.type });
        continue;
      }

      // Resolve the React component — CDN (dynamic-imported, cached) or
      // local TSX (read + Babel-compile in-browser).
      let Component: React.ComponentType<any> | null = null;
      if (node.componentFile.startsWith('http')) {
        Component = getCdnComponent(node.componentFile) as React.ComponentType<any> | null;
        if (!Component) {
          // Not loaded yet — kick off the dynamic import and skip this cycle.
          // `loadCdnComponent` fires `revyme:cdn-component-loaded` on success
          // which triggers the next render pass.
          void loadCdnComponent(node.componentFile);
          continue;
        }
      } else {
        const componentCode = projectFS.readFile(node.componentFile);
        if (!componentCode) {
          trace.error('code-component-host:source-not-found', { nodeId: node.id, file: node.componentFile });
          continue;
        }
        Component = compileCodeComponent(componentCode, node.type);
        if (!Component) {
          trace.error('code-component-host:compile-failed', { nodeId: node.id, component: node.type });
          continue;
        }
      }

      // Extract props from node attributes (the JSX props set by the user)
      const props = extractCodeComponentProps(node);
      trace.action('code-component-host:resolve-props', { nodeId: node.id, propCount: Object.keys(props).length });

      // Resolve prop + attr bindings from map data (item 0 for the template)
      if (node.isCollectionTemplate) {
        const mapParent = findMapParent(node, nodes);
        if (mapParent?.inlineMapData?.[0]) {
          for (const pb of (node.propBindings || [])) {
            const val = mapParent.inlineMapData[0][pb.field];
            // urlWrap = whole-value image binding — the instance source wraps the
            // plain-URL field in url() (`prop={`url(${item.f})`}`); re-apply here
            // since we substitute the RAW field value.
            if (val !== undefined) props[pb.prop] = pb.urlWrap ? `url(${val})` : coerceValue(val);
          }
          for (const ab of (node.attrBindings || [])) {
            const val = mapParent.inlineMapData[0][ab.field];
            if (val !== undefined) props[ab.property] = val;
          }
        }
      }

      // Code components only run in the sandbox iframe (mounted via the bridge below).
    }
    // ─── Ghost Code component mounting: mount Code component instances on .map() ghost copies ──
    // For each Code component node that's inside a collection template, find ghost copies
    // and mount separate React roots with per-item resolved props.
    trace.fn('code-component-host:ghost-sync-pass', { codeComponentCount: codeComponentNodes.filter(n => n.isCollectionTemplate).length });
    for (const node of codeComponentNodes) {
      if (!node.componentFile || !node.isCollectionTemplate) continue;

      // Find the parent that has the collectionList (data source)
      const mapParent = findMapParent(node, nodes);
      if (!mapParent?.inlineMapData) continue;

      const componentCode = projectFS.readFile(node.componentFile);
      if (!componentCode) continue;
      const Component = compileCodeComponent(componentCode, node.type);
      if (!Component) continue;

      // Base props from template (static props)
      const baseProps = extractCodeComponentProps(node);
      trace.action('code-component-host:resolve-props', { nodeId: node.id, propCount: Object.keys(baseProps).length, ghost: true });

      // Mount on ALL ghost copies across ALL viewports (desktop + replicas)
      // data-collection-ghost is on the ghost ROOT, Code component element may be a child inside it.
      // Query both: Code component IS the ghost root, or Code component is INSIDE a ghost root.
      const allGhostEls = document.querySelectorAll(
        `[data-collection-ghost][data-code-component="true"][data-id="${node.id}"], ` +
        `[data-collection-ghost] [data-code-component="true"][data-id="${node.id}"]`
      );

      allGhostEls.forEach(ghostDom => {
        const ghostEl = ghostDom as HTMLElement;
        const ghostNodeId = ghostEl.getAttribute('data-node-id') || '';
        // Extract ghost index from data-node-id: "...nodeId__2" → 2
        const suffixMatch = ghostNodeId.match(/__(\d+)$/);
        if (!suffixMatch) return;
        const gi = parseInt(suffixMatch[1], 10);
        if (gi < 1 || gi >= mapParent!.inlineMapData!.length) return;

        const itemData = mapParent!.inlineMapData![gi];
        const ghostProps = { ...baseProps };
        for (const binding of (node.propBindings || [])) {
          if (itemData[binding.field] !== undefined) {
            // urlWrap: see the template-resolve pass above — re-apply the url() wrap.
            ghostProps[binding.prop] = binding.urlWrap ? `url(${itemData[binding.field]})` : coerceValue(itemData[binding.field]);
          }
        }
        for (const ab of (node.attrBindings || [])) {
          if (itemData[ab.field] !== undefined) {
            ghostProps[ab.property] = itemData[ab.field];
          }
        }

        // Inject canvas viewport width for ghost elements too
        const ghostVpWidth = getCanvasViewportWidth(ghostEl);
        const ghostMountProps = ghostVpWidth !== undefined ? { ...ghostProps, __canvasViewportWidth: ghostVpWidth } : ghostProps;
        const ghostPropsHash = JSON.stringify(ghostMountProps);
        const existing = rootsRef.current.get(ghostNodeId);

        if (existing && existing.component === node.type && existing.propsHash === ghostPropsHash) {
          return;
        }

        if (existing) {
          existing.root.render(React.createElement(Component, ghostMountProps));
          existing.propsHash = ghostPropsHash;
          trace.action('code-component-host:ghost-update', { ghostId: ghostNodeId, component: node.type, itemIndex: gi, vpWidth: ghostVpWidth });
        } else {
          const root = createRoot(ghostEl);
          root.render(React.createElement(Component, ghostMountProps));
          rootsRef.current.set(ghostNodeId, { root, component: node.type, propsHash: ghostPropsHash });
          trace.action('code-component-host:ghost-mount', { ghostId: ghostNodeId, component: node.type, itemIndex: gi, vpWidth: ghostVpWidth });
        }
      });
    }

    // ─── Forward code component mounts to sandbox ───────────────────────
    //
    // Always forward. The sandbox-side `mountCodeComponent` is idempotent —
    // it dedupes internally on (codeHash, propsHash) so repeated calls with
    // the same args are no-ops, and same-code-different-props falls through
    // to a re-render-in-place (no React root teardown). Putting the dedup
    // there instead of here is correct because the sandbox has ground
    // truth: the parent can't know whether a previous mount call actually
    // succeeded (the container may not have been in the sandbox DOM yet),
    // so any parent-side cache risks recording phantom mounts and silently
    // skipping retries.
    //
    // We also unmount nodes that no longer exist so the sandbox doesn't
    // leak React roots after the user deletes a component.
    {
      const bridge = getCanvasBridge();
      if ('mountCodeComponent' in bridge) {
        const pmBridge = bridge as any;
        const seenIds = new Set<string>();
        // Collect every instance's mount request and forward the WHOLE SET in
        // one bridge message (`mountCodeComponentsBatch`). Forwarding one
        // message per instance made each mount its own sandbox macrotask, so
        // the browser painted/reflowed between them — N stacked auto-height
        // instances (e.g. the six advisors-hero Counters) mounted one-per-frame
        // in a visible "dominos" cascade. Batching makes the sandbox create all
        // roots in a single pass → React batches the first commits → one paint.
        const mountBatch: Array<{ nodeId: string; code: string; props: Record<string, any>; vpWidth: number }> = [];
        for (const node of codeComponentNodes) {
          if (!node.componentFile) continue;
          // Sandbox bridge accepts EITHER a full TSX source string OR a
          // CDN URL. The sandbox-side handler detects `https://` prefix and
          // dynamic-imports inside the iframe (Comlink can't ship React
          // components across the boundary, so the sandbox owns its copy
          // of the loaded module). Local TSX still flows as source text
          // so the sandbox runs Babel.
          let codeOrUrl: string | null = null;
          if (node.componentFile.startsWith('http')) {
            codeOrUrl = node.componentFile;
          } else {
            codeOrUrl = projectFS.readFile(node.componentFile);
          }
          if (!codeOrUrl) continue;
          const props = extractCodeComponentProps(node);
          // Per-variant style branches ride along so the sandbox can resolve the
          // RIGHT value per artboard. A component master renders one tile per
          // variant, but `mountCodeComponent` is called ONCE — extractCodeComponentProps
          // only forwards the default-branch `node.styles`. For an INSTANCE child
          // whose width/height are `initialVariant === 'v' ? a : b` ternaries
          // (parsed into `node.conditionalStyles`), the variant tile would
          // otherwise mount at the default size — visible as a vector-set's inner
          // svg rendering at the wrong size on non-default variants. The sandbox
          // picks the branch for each tile's own [data-viewport] variant.
          if (node.conditionalStyles && Object.keys(node.conditionalStyles).length > 0) {
            props.__variantStyles = node.conditionalStyles;
          }
          // Same idea for per-variant PROP overrides (e.g. an icon-set's `name`
          // selecting which vector to show — `name={variant === 'v' ? … : …}`,
          // parsed into node.attrConditional). The sandbox resolves the branch
          // for each tile's variant so a vector set can show a different icon per
          // master variant, exactly like a design-component prop.
          if (node.attrConditional && Object.keys(node.attrConditional).length > 0) {
            props.__variantProps = node.attrConditional;
          }
          // Slot system — canvas nodes connected into this component's
          // slot ride along as `__slotChildren` so the sandbox can render
          // them inside the component (a synced ghost). See slot-children.ts.
          //
          // Pass the FULL slot-connections map so serialization recurses
          // into nested slot wirings (e.g. a Marquee on the canvas wired
          // into another Marquee's slot — its own slot children also
          // need to appear inside the ghost, not just its inline JSX
          // children). Live site already does this implicitly via JSX
          // composition; canvas needs the merged tree explicitly.
          const connectedIds = slotConnectionsRef.current.get(node.id) ?? [];
          const slotKids = serializeSlotChildren(connectedIds, nodes, slotConnectionsRef.current);
          if (slotKids.length > 0) props.__slotChildren = slotKids;
          const vpWidths = getViewportWidths();
          const vpWidth = vpWidths['desktop'] || 1440;
          seenIds.add(node.id);
          mountBatch.push({ nodeId: node.id, code: codeOrUrl, props, vpWidth });
        }

        // Single batched forward (one macrotask in the sandbox → one paint).
        // Falls back to per-instance calls on an older bridge that predates the
        // batch method (DirectBridge / tests), preserving behaviour there.
        if (mountBatch.length > 0) {
          if (typeof pmBridge.mountCodeComponentsBatch === 'function') {
            pmBridge.mountCodeComponentsBatch(mountBatch);
            trace.action('code-component-host:sandbox-mount-batch', { count: mountBatch.length });
          } else {
            for (const m of mountBatch) pmBridge.mountCodeComponent(m.nodeId, m.code, m.props, m.vpWidth);
            trace.action('code-component-host:sandbox-mount-fallback', { count: mountBatch.length });
          }
        }

        // Clean up state for nodes that no longer exist (deleted from canvas) —
        // but DEBOUNCED (see pendingUnmountsRef): schedule the unmount instead of
        // doing it now, so a node that vanishes for one transient page-transition
        // sync and reappears the next one is never torn down (no flicker/stagger).
        for (const id of [...sandboxMountStateRef.current.keys()]) {
          if (!seenIds.has(id) && !pendingUnmountsRef.current.has(id)) {
            const timer = setTimeout(() => {
              pendingUnmountsRef.current.delete(id);
              // Re-fetch the bridge — pmBridge may be stale 250ms later.
              const b = getCanvasBridge() as any;
              b.unmountCodeComponent?.(id);
              sandboxMountStateRef.current.delete(id);
              trace.action('code-component-host:sandbox-unmount', { nodeId: id });
            }, 250);
            pendingUnmountsRef.current.set(id, timer);
          }
        }
        // Track which nodes we've forwarded for the cleanup pass next sync, AND
        // cancel any pending unmount for a node that just came back.
        for (const id of seenIds) {
          const pending = pendingUnmountsRef.current.get(id);
          if (pending !== undefined) { clearTimeout(pending); pendingUnmountsRef.current.delete(id); }
          if (!sandboxMountStateRef.current.has(id)) {
            sandboxMountStateRef.current.set(id, { codeHash: '', propsHash: '' });
          }
        }
      }
    }

  }, []);

  // Sync code components whenever nodes change or renderer completes.
  // Uses a polling interval that runs until all expected ghost mounts succeed,
  // then stops. This eliminates all RAF timing race conditions.
  useEffect(() => {
    let attempts = 0;
    const maxAttempts = 20; // 20 × 100ms = 2s max
    let timer: ReturnType<typeof setTimeout> | null = null;

    const trySync = () => {
      syncCodeComponents();
      attempts++;

      // Keep retrying ONLY while a collection-template GHOST still has no
      // PARENT-frame React root. Ghosts are mounted by this component into
      // `rootsRef` (see the ghost-sync pass above), so `rootsRef.has(nid)` is a
      // truthful "is it mounted?" signal for them.
      //
      // Regular (non-template) instances are NOT mounted here — they're
      // forwarded to the cross-origin sandbox iframe (`mountCodeComponentsBatch`).
      // The parent can't see the sandbox's DOM or its mounted-roots map, so the
      // old `document.querySelectorAll(...)` / `rootsRef.has(nid)` checks below
      // ALWAYS read false for them → `allMounted` could never become true → the
      // 100ms timer churned the full 2s on EVERY load, re-forwarding the whole
      // set 20× and reinforcing the per-frame "dominos" cadence. Regular
      // instances are instead (re)mounted by the `revyme:render-complete` /
      // `revyme:cdn-component-loaded` handlers (which fire AFTER the sandbox has
      // the containers and call `trySync` → the batched forward), so polling for
      // them here was both impossible and unnecessary. Excluding them lets the
      // timer stop as soon as the real (ghost) work is done.
      const codeComponentNodes = [...nodesRef.current.values()].filter(n => n.isCodeComponent);
      let allMounted = true;
      for (const node of codeComponentNodes) {
        if (node.isCollectionTemplate) {
          // Ghost copies inside a .map() template
          const ghostEls = document.querySelectorAll(
            `[data-collection-ghost][data-code-component="true"][data-id="${node.id}"], ` +
            `[data-collection-ghost] [data-code-component="true"][data-id="${node.id}"]`
          );
          for (const el of Array.from(ghostEls)) {
            const nid = el.getAttribute('data-node-id') || '';
            if (!rootsRef.current.has(nid)) { allMounted = false; break; }
          }
        } else {
          // Regular code component — sandbox-managed; not gated here (see above).
          continue;
        }
        if (!allMounted) break;
      }

      if (!allMounted && attempts < maxAttempts) {
        trace.action('code-component-host:retry', { attempt: attempts, maxAttempts });
        timer = setTimeout(trySync, 100);
      }
    };

    // Sync immediately for prop updates (DOM already exists).
    // For initial mount, render-complete event handles it.
    syncCodeComponents();

    // Also sync on render-complete event (immediate, no delay needed)
    const handler = () => { attempts = 0; trySync(); };
    window.addEventListener('revyme:render-complete', handler);
    // Re-sync when a CDN Code component finishes loading
    window.addEventListener('revyme:cdn-component-loaded', handler);

    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('revyme:render-complete', handler);
      window.removeEventListener('revyme:cdn-component-loaded', handler);
    };
  }, [nodes, syncCodeComponents]);

  // Cleanup on unmount
  useEffect(() => {
    const pending = pendingUnmountsRef.current;
    return () => {
      for (const [, entry] of rootsRef.current) {
        entry.root.unmount();
      }
      rootsRef.current.clear();
      for (const [, t] of pending) clearTimeout(t);
      pending.clear();
      clearCodeComponentCache();
      trace.action('code-component-host:cleanup');
    };
  }, []);

  return null; // This component renders nothing — it manages portals imperatively
}
