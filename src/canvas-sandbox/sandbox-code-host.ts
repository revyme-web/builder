// sandbox-code-host.ts — Code component host for the sandbox iframe.
// Compiles and mounts Code components on canvas elements inside the iframe.
// Uses the same compilation pipeline as the parent's code-component-runtime.ts.
//
// Two source paths the parent can send via the bridge:
//   - TSX source string  → Babel-compile in-iframe via `compileCodeComponent`
//   - CDN URL (https://) → native dynamic `import(url)` inside the iframe,
//     with a small in-iframe cache so the same URL only loads once. Mirrors
//     the parent's `cdn-component-cache.ts` but lives in the sandbox so the
//     loaded React component shares the iframe's React instance (postMessage
//     can't ship live components across the boundary). The bundle's nested
//     URL imports resolve recursively via the browser's native ESM loader —
//     same model as the reference's `a hosted CDN` recursion.

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MotionConfig } from 'framer-motion';
import { compileCodeComponent } from '@/canvas/code-component-runtime';
import { buildSlotChildren } from '@/canvas/slot-children';
import { emitRectAndCornersForElement, scheduleRemeasureAllRects } from './sandbox/rect-emit';
import { isSandboxDragSettling } from './sandbox-dnd-host';
import { trace } from '@/shared/debug-trace';
import { coerceScalar } from '@/code/values/value-eval';

/**
 * Build the inner React element for a mounted code component, threading any
 * connected SLOT children (shipped from the parent as a `__slotChildren`
 * prop) through as real React `children`. Without this, slot-bearing
 * components (LensBox, …) render empty on the canvas even though the
 * connected canvas node exists. See `slot-children.ts`.
 */
function makeInner(
  Component: React.ComponentType<any>,
  props: Record<string, any>,
  vpWidth: number,
): React.ReactElement {
  const { __slotChildren, ...rest } = props;
  const kids = Array.isArray(__slotChildren) ? buildSlotChildren(__slotChildren) : [];
  return React.createElement(Component, { ...rest, __canvasViewportWidth: vpWidth }, ...kids);
}

// Sentinel transition for CDN-mounted components on the canvas. Motion
// respects `MotionConfig.transition` as the DEFAULT — every motion.*
// inside the loaded bundle (including its `layout={true}` FLIP animations
// and `variants` transitions) skips animation when wrapped in this. Live
// preview / production keeps full animations because that path doesn't
// go through the canvas sandbox at all.
const NO_ANIMATION_TRANSITION = { duration: 0, type: 'tween' as const };

/** True when `code` is a CDN URL (vs. inline TSX source). Cheap startsWith
 *  check, same one used elsewhere in the URL-vs-source branching. */
function isCdnUrl(code: string): boolean {
  return code.startsWith('http://') || code.startsWith('https://');
}

/** True when `code` is a vector-set / icon-set component source. Its instance
 *  compiles to a `motion.div` with `layout={true}` (flowing in via `...rest`),
 *  so framer-motion's layout-FLIP projection re-acquires the box and ANIMATES
 *  every size change — making a resize visibly tween to its new size instead of
 *  snapping. The `if (!name) return master;` line is unique to the icon-set
 *  instance branch (same marker `upgradeVectorSetInstanceBranch` keys on). */
export function isVectorSetSource(code: string): boolean {
  return code.includes('  if (!name) return master;');
}

/** Suppress framer-motion animation on the CANVAS for CDN imports AND vector
 *  sets: both should snap (resize / variant-switch) while editing. The live
 *  preview / production render bypasses this sandbox entirely, so real
 *  animations are untouched there. */
export function disableCanvasAnimations(code: string): boolean {
  return isCdnUrl(code) || isVectorSetSource(code);
}

/** True when the user set an explicit value for `axis` on the instance
 *  via `node.styles` (forwarded as `props.style` by `extractCodeComponentProps`).
 *  Treats an empty string the same as missing so a `width: ''` clear
 *  also turns OFF the size-baking loop (matches the project's
 *  empty-string-removes-property convention).
 *
 *  Used by `mountCodeComponent` and `reRenderWithCurrentSize` to decide
 *  whether the wrapper drives the inner render's size (user-dim path:
 *  drag-resize live feedback) or the inner's natural source-baked size
 *  drives the wrapper (no-dim path: freshly-pasted CDN component
 *  rendering at its authored size). */
function hasUserDim(style: any, axis: 'width' | 'height'): boolean {
  if (!style || typeof style !== 'object') return false;
  const v = style[axis];
  return v != null && v !== '';
}

// ─── In-iframe CDN component cache ─────────────────────────────────────────
// Keyed by URL. Values: the loaded React component (after dynamic-import
// resolves). Pending URLs sit in `_pending` while their import is in flight
// to coalesce concurrent mountCodeComponent calls for the same URL into one
// network request.
const _cdnComponents = new Map<string, React.ComponentType<any>>();
const _cdnPending = new Map<string, Promise<React.ComponentType<any> | null>>();

// Mount calls that arrived while their URL was still loading. Replayed when
// the URL resolves so the user doesn't have to wait for the next render-
// complete cycle from the parent (which would be triggered by user
// interaction, not automatic). Stored by URL since multiple mounts can be
// waiting on the same dependency (e.g. five `<MeshGradient />` instances).
interface PendingMount {
  contentRoot: HTMLElement;
  nodeId: string;
  code: string;
  props: Record<string, any>;
  vpWidth: number;
}
const _pendingMountsByUrl = new Map<string, PendingMount[]>();

function getCdnComponent(url: string): React.ComponentType<any> | null {
  return _cdnComponents.get(url) ?? null;
}

function loadCdnComponent(url: string): Promise<React.ComponentType<any> | null> {
  if (_cdnComponents.has(url)) return Promise.resolve(_cdnComponents.get(url)!);
  const existing = _cdnPending.get(url);
  if (existing) return existing;
  const promise = import(/* @vite-ignore */ url)
    .then((mod) => {
      const Component = (mod && (mod.default ?? mod)) as React.ComponentType<any>;
      _cdnComponents.set(url, Component);
      _cdnPending.delete(url);
      trace.action('sandbox-cdn:loaded', { url });
      // Replay any mount calls that arrived while we were loading.
      const queued = _pendingMountsByUrl.get(url) ?? [];
      _pendingMountsByUrl.delete(url);
      for (const m of queued) {
        try {
          mountCodeComponent(m.contentRoot, m.nodeId, m.code, m.props, m.vpWidth);
        } catch (err) {
          trace.error('sandbox-cdn:replay-mount-failed', { nodeId: m.nodeId, url, error: err instanceof Error ? err.message : String(err) });
        }
      }
      // Same event name as the parent's cdn-component-cache for parity —
      // anyone listening on the iframe window can react.
      window.dispatchEvent(new CustomEvent('revyme:cdn-component-loaded', { detail: { url } }));
      return Component;
    })
    .catch((err) => {
      _cdnPending.delete(url);
      _pendingMountsByUrl.delete(url);
      trace.error('sandbox-cdn:load-failed', { url, error: err instanceof Error ? err.message : String(err) });
      return null;
    });
  _cdnPending.set(url, promise);
  return promise;
}

function queuePendingMount(url: string, mount: PendingMount): void {
  const list = _pendingMountsByUrl.get(url);
  if (list) list.push(mount);
  else _pendingMountsByUrl.set(url, [mount]);
}

interface MountedComponent {
  root: Root;
  /** The unprefixed data-id of the source node (shared across viewport replicas). */
  nodeId: string;
  /** The prefixed data-node-id of THIS specific container (e.g. "tablet-MatrixRain-..."). */
  containerNodeId: string;
  /** The actual DOM container — held so the ResizeObserver can re-read its size on tick. */
  container: HTMLElement;
  Component: React.ComponentType<any>;
  props: Record<string, any>;
  vpWidth: number;
  /** Hash of the code string that this root was compiled from. Lets us
   *  detect when the user edited the master file and we need to recompile,
   *  vs. when the parent is just re-sending the same code (which is the
   *  common case during the parent's retry loop / render-complete fanout). */
  codeHash: string;
  /** Hash of the last props we rendered with — used by `mountCodeComponent`
   *  to dedupe identical re-mount requests so we don't tear down the React
   *  root and cancel any in-flight requestAnimationFrame / WebGL setup. */
  propsHash: string;
  /**
   * Watches the container's bounding box during canvas resize. ResizeManager
   * patches inline width/height directly via the bridge (`domOnly: true`)
   * which bypasses `nodes` atom — so the parent host never re-fires
   * `mountCodeComponent` mid-drag. Without this observer the inner React
   * component would only see the new size on mouseup (when the mutation
   * queue finally flushes). With it, every size change re-renders the React
   * tree using fresh `style.width / style.height` props so components like
   * GlitchText (which reads `props.style.width`) snap to the dragged size live.
   */
  resizeObserver: ResizeObserver | null;
  /** Last (width, height) we rendered with — guards against ResizeObserver
   *  storms where the size hasn't actually changed (sub-pixel jitter). */
  lastRenderedSize: { w: number; h: number };
  /** True iff the user set explicit width/height on the instance via
   *  `node.styles` (passed through `extractCodeComponentProps` → `props.style`).
   *  When false (e.g. a freshly-pasted CDN component with no
   *  dimensions), `reRenderWithCurrentSize` MUST NOT inject the
   *  wrapper's offsetWidth/offsetHeight back into the component's
   *  style — doing so locks the inner render to the wrapper's tiny
   *  minWidth/minHeight fallback (100×40) on the very first
   *  ResizeObserver tick, which fires BEFORE React commits the
   *  initial render. The bundle's `...style` spread then propagates
   *  that 100×40 forward forever, while pieces inside the component
   *  with their own absolute positioning visibly overflow the
   *  wrapper. With this flag false, we let the inner render at its
   *  natural source-baked size and the wrapper auto-sizes to fit
   *  (position: absolute + no width/height = shrink-to-content). */
  hasUserDims: { width: boolean; height: boolean };
}

/**
 * Mounted roots keyed by the prefixed `data-node-id`, NOT the unprefixed
 * `data-id`. A single dropped code component renders as N containers (one
 * per visible viewport: desktop, tablet, mobile, ...) — each gets its own
 * React root so they animate independently. Without this keying, only the
 * first viewport's replica would mount and the others stayed empty.
 */
const mounted = new Map<string, MountedComponent>();

/** Cheap stable hash of a props object — good enough for change detection. */
function hashProps(props: Record<string, any>, vpWidth: number): string {
  return JSON.stringify(props) + '|' + vpWidth;
}

/** A component master renders ONE [data-viewport] tile per variant, but
 *  `mountCodeComponent` is called once with the default-branch props. A code-
 *  component INSTANCE inside the master carries its per-variant style branches
 *  in `props.__variantStyles` (the parser's `conditionalStyles` map — shape
 *  `{ width: { 'variant-1': '542px', default: '430px' }, … }`). Resolve the
 *  branch for THIS container's variant — its viewport id (`data-viewport`);
 *  primary / unknown ids fall back to the `default` branch — and bake it into
 *  `props.style`, then drop `__variantStyles` so it never reaches the component.
 *  Without this every tile mounts at the default size and a vector-set's inner
 *  svg renders wrong on non-default variants. */
// framer-motion transform props that the canvas CONTAINER owns (so the inner
// mount must not also resolve them — see resolveVariantProps).
const MOTION_TRANSFORM_STYLE_PROPS = new Set([
  'rotate', 'rotateX', 'rotateY', 'rotateZ',
  'scale', 'scaleX', 'scaleY',
  'skewX', 'skewY', 'x', 'y', 'z', 'transformPerspective',
]);

export function resolveVariantProps(props: Record<string, any>, variant: string | null): Record<string, any> {
  const vs = props.__variantStyles as Record<string, Record<string, string>> | undefined;
  const vp = props.__variantProps as Record<string, Record<string, string>> | undefined;
  if (!vs && !vp) return props;
  const { __variantStyles, __variantProps, ...rest } = props;
  // Pick the branch for this tile's variant; primary / unknown ids fall back to
  // the `default` branch (then the value already on the element).
  const pick = (branches: Record<string, string>, current: any) =>
    (variant != null && branches[variant] != null)
      ? branches[variant]
      : (branches['default'] != null ? branches['default'] : current);
  if (vs) {
    const style: Record<string, any> = { ...(rest.style || {}) };
    for (const [prop, branches] of Object.entries(vs)) {
      // Motion TRANSFORM props (rotate/scale/x/y/skew) are handled by the CANVAS
      // CONTAINER (the Renderer folds conditionalStyles.rotate into its CSS
      // transform — that's what the rotate handle + selection overlay operate on).
      // The icon-set instance body ALSO lifts these into the inner's `animate`, so
      // resolving them onto the inner's style here would DOUBLE the rotation and
      // fight the rotate handle. Skip them — the inner keeps its base (neutral)
      // value on the canvas; the live site (no container) animates the inner.
      if (MOTION_TRANSFORM_STYLE_PROPS.has(prop)) continue;
      const resolved = pick(branches, style[prop]);
      if (resolved != null) style[prop] = resolved;
    }
    rest.style = style;
  }
  // Per-variant PROP overrides (e.g. an icon-set's `name`) resolve onto the
  // top-level prop, not into style.
  if (vp) {
    for (const [prop, branches] of Object.entries(vp)) {
      const resolved = pick(branches, rest[prop]);
      if (resolved != null) {
        // Branch values arrive as STRINGS from the parsed ternary — coerce
        // typed literals so a toggle's 'false' branch isn't truthy and a
        // number control gets a real number (per-variant code-component
        // props, 2026-07-31).
        rest[prop] = resolved === 'true' ? true
          : resolved === 'false' ? false
          : (typeof resolved === 'string' && /^-?\d+(?:\.\d+)?$/.test(resolved)) ? Number(resolved)
          : resolved;
      }
    }
  }
  return rest;
}

/**
 * Re-render an entry with the container's CURRENT size baked into
 * `props.style.width / height`. Called from the ResizeObserver attached at
 * mount time so resize feels live rather than snapping at mouseup.
 *
 * Skips when the size hasn't actually changed (sub-pixel jitter / observer
 * storms during transition animations).
 */
function reRenderWithCurrentSize(entry: MountedComponent): void {
  const w = entry.container.offsetWidth;
  const h = entry.container.offsetHeight;
  if (w === entry.lastRenderedSize.w && h === entry.lastRenderedSize.h) return;
  entry.lastRenderedSize = { w, h };

  // The wrapper's measured size just changed. Push a rectUpdate to
  // the parent so its rectCache picks up the new bounds — without
  // this, the SelectionOverlay + Position panel + every other
  // bridge-cache reader would keep showing the previous (often
  // placeholder 100×40) rect until some unrelated mutation walked
  // the subtree refresh. Cold-loading a CDN design component is the
  // most visible case: wrapper auto-grows on React commit but no
  // mutation fires, so the overlay stays tiny until you drag.
  emitRectAndCornersForElement(entry.container);

  // The wrapper just changed size, so everything BELOW it in document flow
  // shifted — not just its ancestors but every following sibling and their
  // descendants (e.g. an auto-height viewport frame grows AND the FAQ section
  // under a testimonials marquee slides down). A per-element/ancestor refresh
  // leaves those following nodes' cached rects stale, so their overlays sit
  // offset until a drag forces a full re-render. Schedule a full positional
  // re-measure (rAF-debounced, rect+corners only, no DOM/root rebuild) so the
  // whole shift lands. This is the real fix that lets `height/width: auto`
  // code components behave like fixed-px ones.
  //
  // …EXCEPT during a drag settle: a reparent/unparent re-mounts every code
  // component, and each re-mount's placeholder→real growth fires this observer,
  // scheduling a full 2360-element sweep — TWICE — right after the drop's own
  // render already measured everything (the traced ~240ms unparent-settle
  // hotspot). The per-element emit above keeps THIS wrapper's rect fresh; the
  // page-wide shift, if any, is already in the drop's measure. Skip the sweep.
  if (!isSandboxDragSettling()) scheduleRemeasureAllRects();

  // No explicit width/height on the instance → nothing to bake into
  // props.style, the React tree wouldn't change, so skip the
  // re-render. We've already pushed the rect update above so the
  // parent's overlay catches up regardless. Saves a reconciliation
  // (and its layout-affecting effects) per ResizeObserver tick on
  // every freshly-pasted CDN component.
  if (!entry.hasUserDims.width && !entry.hasUserDims.height) return;

  // Only force the wrapper size into the inner render when the user
  // EXPLICITLY set that axis on the instance. Without this guard the
  // first ResizeObserver tick (which fires before React commits the
  // initial render, when the wrapper is still at min 100×40) would
  // bake those placeholder dimensions into props.style and lock the
  // component to them — defeating the whole "import without
  // hard-coded size" change. See the `hasUserDims` field comment.
  const liveStyle: Record<string, any> = { ...(entry.props.style || {}) };
  if (entry.hasUserDims.width) liveStyle.width = `${w}px`;
  if (entry.hasUserDims.height) liveStyle.height = `${h}px`;
  const liveProps = { ...entry.props, style: liveStyle };
  const inner = makeInner(entry.Component, liveProps, entry.vpWidth);
  // CDN imports + vector sets: keep the same MotionConfig wrapper on every
  // resize tick so framer-motion's layout-FLIP doesn't re-acquire its
  // default transition mid-drag and start animating again.
  const wrapped = disableCanvasAnimations(entry.codeHash)
    ? React.createElement(MotionConfig, { transition: NO_ANIMATION_TRANSITION }, inner)
    : inner;
  entry.root.render(wrapped);
}

/**
 * Mount a code component on EVERY canvas container that has this `data-id`.
 * That means primary viewport + every replica viewport (tablet, mobile, ...).
 * Each container gets its own React root so they animate independently —
 * Revyme renders the same logical node N times, one per viewport, and
 * we need to honour that here.
 *
 * IDEMPOTENT per container: if a root for a container already exists with
 * the same code + props, that container's call is a no-op. The parent's
 * CodeComponentHost retry loop fires this up to ~20× over 2s while waiting
 * for the sandbox to render containers; without dedupe we'd unmount +
 * remount on every call, cancelling rAF / WebGL inits.
 */
export function mountCodeComponent(
  contentRoot: HTMLElement,
  nodeId: string,
  code: string,
  props: Record<string, any>,
  vpWidth: number,
): void {
  // Find ALL containers in the sandbox DOM matching this data-id —
  // one per viewport. Skip ghost copies (those are managed by the
  // collection-template path on the parent side).
  const containers = contentRoot.querySelectorAll<HTMLElement>(
    `[data-id="${nodeId}"][data-code-component]:not([data-collection-ghost])`,
  );
  if (containers.length === 0) {
    // Nothing rendered by the sandbox yet — silently bail.
    // The parent will retry on the next renderComplete.
    return;
  }

  let Component: React.ComponentType<any> | null = null;

  for (const container of Array.from(containers)) {
    const containerNodeId = container.getAttribute('data-node-id') || nodeId;
    // Each replica needs ITS viewport's width so `withResponsiveProps`
    // inside the rendered component can pick the right responsive override
    // from `data-responsive`. Read it from the nearest `[data-viewport]`
    // ancestor — the sandbox renderer stamps `data-viewport-width` on every
    // viewport element. Falls back to the parent-supplied vpWidth (desktop
    // baseline) when there is no viewport ancestor (e.g. canvas-only nodes).
    const vpEl = container.closest<HTMLElement>('[data-viewport]');
    const containerVpWidth = vpEl
      ? parseFloat(vpEl.getAttribute('data-viewport-width') || '') || vpWidth
      : vpWidth;
    // Resolve per-variant style branches for THIS tile (its viewport id is the
    // variant name on a component master). Each tile is its own `mounted` entry
    // (keyed by the prefixed containerNodeId), so the resolved style is baked
    // into the hash → a variant change re-renders that tile in place.
    const cProps = resolveVariantProps(props, vpEl?.getAttribute('data-viewport') ?? null);
    const propsHash = hashProps(cProps, containerVpWidth);
    let existing = mounted.get(containerNodeId);

    // Container-identity guard: if the data-node-id matches but the actual
    // DOM node was rebuilt (move-into-viewport / move-out-of-viewport
    // structurally rebuilds the wrapper, see CLAUDE.md "Move changes
    // parent — DOM must be fully rebuilt"), the existing React root is
    // attached to a detached container — its inner div never paints into
    // the new wrapper. Tear it down and treat this as a fresh mount on
    // the live container.
    if (existing && (existing.container !== container || !existing.container.isConnected)) {
      trace.action('sandbox-code-host:container-rebuilt', { containerNodeId });
      existing.resizeObserver?.disconnect();
      try { existing.root.unmount(); } catch { /* ignore */ }
      mounted.delete(containerNodeId);
      existing = undefined;
    }

    // Same code + same props → nothing to do. Hot path during retry / resize storms.
    if (existing && existing.codeHash === code && existing.propsHash === propsHash) {
      continue;
    }

    // Same code, different props → re-render in place (no recompile, no
    // root teardown). Keeps in-flight rAF / observers alive.
    if (existing && existing.codeHash === code) {
      const coercedProps = coerceProps(cProps);
      existing.props = coercedProps;
      existing.vpWidth = containerVpWidth;
      existing.propsHash = propsHash;
      // Refresh user-dim flags from the latest props.style — toggles when
      // the user adds/removes width/height on the instance via the
      // panel (so a freshly-set explicit dim immediately re-engages the
      // wrapper-drives-inner resize loop, and clearing it back to auto
      // re-engages the natural sizing path).
      existing.hasUserDims = {
        width: hasUserDim(coercedProps.style, 'width'),
        height: hasUserDim(coercedProps.style, 'height'),
      };
      const inner = makeInner(existing.Component, coercedProps, containerVpWidth);
      // CDN imports + vector sets: suppress framer-motion animations on the
      // canvas. Resize / variant-switch should be instant here; the
      // animations are only meaningful in live preview / production.
      const wrapped = disableCanvasAnimations(code)
        ? React.createElement(MotionConfig, { transition: NO_ANIMATION_TRANSITION }, inner)
        : inner;
      existing.root.render(wrapped);
      continue;
    }

    // Different code (file edited / different component) → full re-mount.
    if (existing) {
      existing.resizeObserver?.disconnect();
      try { existing.root.unmount(); } catch { /* ignore */ }
      mounted.delete(containerNodeId);
    }

    try {
      // Compile lazily and reuse across containers — same source for all viewports.
      if (!Component) {
        if (code.startsWith('http://') || code.startsWith('https://')) {
          // CDN URL path: dynamic-import inside the iframe so the loaded
          // module shares this iframe's React instance. If the import is
          // still in flight, queue this mount call and bail out — when
          // the URL resolves the queued mounts get replayed automatically.
          const cached = getCdnComponent(code);
          if (cached) {
            Component = cached;
          } else {
            queuePendingMount(code, { contentRoot, nodeId, code, props, vpWidth });
            void loadCdnComponent(code);
            trace.action('sandbox-code-host:cdn-pending', { nodeId, url: code });
            return;
          }
        } else {
          Component = compileCodeComponent(code, nodeId);
          if (!Component) {
            trace.error('sandbox-code-host:compile-null', { nodeId });
            return;
          }
        }
      }

      const root = createRoot(container);
      const coercedProps = coerceProps(cProps);

      const inner = makeInner(Component, coercedProps, containerVpWidth);
      // CDN imports + vector sets → wrap in MotionConfig with disabled
      // transitions so layout-FLIP / variant transitions / animate=…
      // are instant on the canvas. See same wrapper in the props-only
      // re-render branch above.
      const wrapped = disableCanvasAnimations(code)
        ? React.createElement(MotionConfig, { transition: NO_ANIMATION_TRANSITION }, inner)
        : inner;
      root.render(wrapped);

      const entry: MountedComponent = {
        root, nodeId, containerNodeId, container, Component, props: coercedProps,
        vpWidth: containerVpWidth,
        codeHash: code, propsHash,
        resizeObserver: null,
        lastRenderedSize: { w: container.offsetWidth, h: container.offsetHeight },
        hasUserDims: {
          width: hasUserDim(coercedProps.style, 'width'),
          height: hasUserDim(coercedProps.style, 'height'),
        },
      };

      // Live-resize: watch the container so width/height changes during a
      // ResizeManager drag re-render the React tree with fresh size props.
      // Use the entry-scoped observer (not a single shared one) because each
      // viewport replica's container needs its own size loop.
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => reRenderWithCurrentSize(entry));
        ro.observe(container);
        entry.resizeObserver = ro;
      }

      mounted.set(containerNodeId, entry);
    } catch (err) {
      trace.error('sandbox-code-host:mount-failed', {
        containerNodeId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** One forwarded mount request — same shape `mountCodeComponent` takes,
 *  minus `contentRoot` (the sandbox owns the single content root). */
export interface CodeComponentMount {
  nodeId: string;
  code: string;
  props: Record<string, any>;
  vpWidth: number;
}

/**
 * Mount MANY code-component instances in ONE synchronous pass.
 *
 * This is the anti-"dominos" path. The parent (`CodeComponentHost`) forwards
 * EVERY code-component instance on the page in a single bridge message, and
 * this loop creates all their React roots before the task yields. Why that
 * matters: each `mountCodeComponent` call ends with `createRoot(...).render(...)`.
 * When the parent forwarded one bridge message PER instance, every message was
 * a separate macrotask, and the browser took a render-opportunity (layout +
 * paint) BETWEEN consecutive messages. So six stacked auto-height instances
 * (the advisors hero `Counter`s, 0px until their root commits) reflowed
 * one-after-another — the page visibly shoved down step by step. Doing the
 * whole set in one macrotask lets React batch every root's first commit into a
 * single paint, so all instances appear together.
 *
 * Each entry still flows through the idempotent per-container `mountCodeComponent`,
 * so dedupe / re-render-in-place / per-replica iteration / CDN-pending queueing
 * all behave exactly as before — only the call batching changes.
 */
export function mountCodeComponentsBatch(
  contentRoot: HTMLElement,
  mounts: CodeComponentMount[],
): void {
  trace.action('sandbox-code-host:mount-batch', { count: mounts.length });
  for (const m of mounts) {
    try {
      mountCodeComponent(contentRoot, m.nodeId, m.code, m.props, m.vpWidth);
    } catch (err) {
      trace.error('sandbox-code-host:mount-batch-entry-failed', {
        nodeId: m.nodeId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Unmount a code component. Tears down EVERY root keyed against this
 * unprefixed `nodeId` — i.e. all viewport replicas at once.
 */
export function unmountCodeComponent(nodeId: string): void {
  for (const [containerNodeId, entry] of [...mounted.entries()]) {
    if (entry.nodeId !== nodeId) continue;
    entry.resizeObserver?.disconnect();
    try { entry.root.unmount(); } catch { /* ignore */ }
    mounted.delete(containerNodeId);
  }
}

/**
 * Update props on a mounted code component (no recompile).
 */
export function updateCodeComponentProps(
  nodeId: string,
  props: Record<string, any>,
  _vpWidth: number,
): void {
  // Update EVERY replica's root — code components live in primary + tablet +
  // mobile + ... and they all share the same source props. Each replica
  // keeps its OWN vpWidth (stamped at mount time from the viewport's
  // `data-viewport-width`) so `withResponsiveProps` inside the component
  // can resolve `data-responsive` overrides per viewport. The vpWidth
  // arg is ignored here; we trust the per-entry value the mount path set.
  for (const entry of mounted.values()) {
    if (entry.nodeId !== nodeId) continue;
    // Resolve per-variant style branches for THIS entry's tile (same as the
    // mount path) so a live prop edit doesn't overwrite a non-default tile with
    // the default-branch size.
    const variant = entry.container.closest('[data-viewport]')?.getAttribute('data-viewport') ?? null;
    const cProps = resolveVariantProps(props, variant);
    const coercedProps = coerceProps(cProps);
    const propsHash = hashProps(cProps, entry.vpWidth);
    // Same props (with the same vpWidth) as last render → skip. Avoids
    // redundant React commits during continuous resize / slider drags.
    if (entry.propsHash === propsHash) continue;

    entry.props = coercedProps;
    entry.propsHash = propsHash;

    entry.root.render(makeInner(entry.Component, coercedProps, entry.vpWidth));
  }
}

/**
 * Sync all code components after a render. Finds data-code-component elements
 * and mounts/unmounts as needed. `mountCodeComponent` is itself idempotent
 * and handles the per-replica iteration internally, so we just forward.
 */
export function syncCodeComponents(
  contentRoot: HTMLElement,
  nodeData: Map<string, { code: string; props: Record<string, any>; vpWidth: number }>,
): void {
  // Mount / update — `mountCodeComponent` handles dedupe + props-only fast path internally.
  for (const [nodeId, data] of nodeData) {
    mountCodeComponent(contentRoot, nodeId, data.code, data.props, data.vpWidth);
  }

  // Unmount removed: collect unique unprefixed nodeIds currently mounted,
  // drop any not present in the new nodeData. `mounted` is keyed by
  // prefixed `data-node-id`, so we must read `entry.nodeId` to compare.
  const mountedNodeIds = new Set<string>();
  for (const entry of mounted.values()) mountedNodeIds.add(entry.nodeId);
  for (const nodeId of mountedNodeIds) {
    if (!nodeData.has(nodeId)) {
      unmountCodeComponent(nodeId);
    }
  }
}

/** Coerce string props to appropriate types (same as CodeComponentHost). */
function coerceProps(raw: Record<string, any>): Record<string, any> {
  // Canonical coercion in value-eval.coerceScalar (shared with CodeComponentHost.coerceValue): only
  // unambiguous scalars ('true'/'false'/pure-number) coerce; unit-bearing strings ('16px') stay strings.
  const result: Record<string, any> = {};
  for (const [key, val] of Object.entries(raw)) result[key] = coerceScalar(val);
  return result;
}
