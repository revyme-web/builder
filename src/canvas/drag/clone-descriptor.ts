// clone-descriptor.ts — canvas clone descriptor builder (shared by
// AbsoluteInFrameStrategy, CanvasDragStrategy and LayoutLiftedStrategy).
//
// Recursively builds an `addCanvasNode` descriptor that mirrors a node's JSX
// subtree with FRESH ids on every node. Used by the variant-exit / replica
// drag-out branches so the original (still in its parent's JSX) and the
// canvas-mounted clone don't collide on `data-id`. Children are walked from
// the parser's CanvasNode map; expanded component descendants and instance
// internals are skipped — those re-materialize at parse time from their
// master definitions and shouldn't be inlined.

import { getDefaultStore } from 'jotai';
import { trace } from '@/shared/debug-trace';
import { generateNodeId, fitTextInnerId } from '@/shared/id-utils';
import { motionPropsToCSSTransform, MOTION_TRANSFORM_PROPS } from '@/shared/motion-transform';
import { containerOverridesAtom, resolveEffectiveStylesForViewport } from '@/code/stores/container-query-store';
import { getSortedBreakpointWidths } from '@/code/stores/viewport-store';
import { queryToViewportSet } from '@/code/animations/animation-scope';
import { serializeVarOrphanBindings, resolveVarOrphansForVariant } from '@/code/generation/component-var-detach-gen';
import { dormantizeCloneBindings, bakeCmsValuesOnClone } from '@/code/generation/cms-detach-gen';
import { resolveCmsRowValues } from '@/code/generation/cms-row-resolve';
import { projectFS } from '@/code/project/project-fs';
import { getActiveFilePath } from '@/canvas/node-ops';

export function buildCanvasCloneDescriptor(
  sourceId: string,
  nodes: import('@/shared/types').NodeMap,
  idMap: Map<string, string>,
  sourceVpWidth?: number,
  sourceVariant?: string,
): import('@/code/generation/generator-crud').AddNodeDef | null {
  const src = nodes.get(sourceId);
  if (!src) return null;

  // SOURCE-VP VISIBILITY CHECK. Drop the entire node (and its subtree)
  // if it's not visible on the source vp the user dragged out from.
  // Two scenarios this guards:
  //
  //   1. Child hidden ONLY on source vp (inline display:'none' with
  //      NO `@container display:'unset'` override for sourceVpWidth):
  //      user dragged out a parent on primary, primary's child has
  //      display:none → user didn't SEE the child, the clone shouldn't
  //      show it either.
  //
  //   2. Child visible only on a DIFFERENT vp (display:none inline +
  //      `@container display:'unset'` on a vp that isn't ours): from
  //      the source vp's POV the child wasn't visible.
  //
  // Effective display = inline `display` after merging the source vp's
  // `@container` override (empty/'auto' in the override means "not
  // set", fall back to inline). If effective is 'none', skip the node.
  // Root of the clone (sourceId passed by the call site) is always
  // kept — the user wouldn't drag an invisible element.
  // Resolve the source variant's per-node override map. Component master
  // variants live in `motionVariants[sourceVariant]` (e.g.
  // `variants[variantName].display = 'flex'`). On canvas root the
  // variant context is gone, so the clone must BAKE IN whatever the user
  // saw on that variant — otherwise inline values dominate and
  // properties the user authored only on the variant (display/flex/
  // position/etc.) silently drop. Map 'desktop'→'default' for the
  // primary-variant case (variantConfig uses 'default' as the key).
  const variantKey = sourceVariant === 'desktop' ? 'default' : sourceVariant;
  const variantOverride: Record<string, string> | null =
    (variantKey && src.motionVariants?.[variantKey]) || null;

  const isRoot = idMap.size === 0;
  if (!isRoot && (sourceVpWidth || variantOverride)) {
    // PAGE replica visibility: read @container display override.
    const overrides = sourceVpWidth ? getDefaultStore().get(containerOverridesAtom) : null;
    const nodeOverrides = overrides?.get(sourceId)?.get(sourceVpWidth!);
    const containerDisplay = nodeOverrides?.get('display');
    // COMPONENT variant visibility: read motionVariants[variantKey].display.
    const variantDisplay = variantOverride?.display;
    // Variant beats container (component context dominates page replica
    // semantics when both apply — though they rarely co-occur on the
    // same node).
    const displayOverride = (variantDisplay && variantDisplay !== '' && variantDisplay !== 'auto')
      ? variantDisplay
      : (containerDisplay && containerDisplay !== '' && containerDisplay !== 'auto')
        ? containerDisplay
        : undefined;
    const effectiveDisplay = displayOverride ?? src.styles?.display;
    if (effectiveDisplay === 'none') {
      trace.action('canvas-clone:skip-hidden-on-source-vp', {
        sourceId, sourceVpWidth, sourceVariant,
        inlineDisplay: src.styles?.display,
        overrideDisplay: displayOverride,
      });
      return null;
    }
  }

  // FIT text wrapper: the whole fit system (panel classification, typing
  // re-fit, Font Size "fit" control, unwrap) keys on the `<textId>-svg` id
  // pairing. A plain fresh id here turned the clone into an anonymous <svg>
  // — the editor showed SHAPE controls (stroke/fill) for what is a text node
  // (live find 2026-07-03). Keep the convention: pre-seed the inner text's
  // new id and name the wrapper `<innerNewId>-svg`. The recursion below then
  // reuses the seeded id for the inner node via the idMap check.
  let newId = idMap.get(sourceId);
  if (!newId) {
    const fitInnerSrcId = src.type === 'svg' ? fitTextInnerId(sourceId) : null;
    if (fitInnerSrcId) {
      const innerNewId = idMap.get(fitInnerSrcId) ?? generateNodeId('detach');
      idMap.set(fitInnerSrcId, innerNewId);
      newId = `${innerNewId}-svg`;
      trace.action('canvas-clone:fit-pair', { sourceId, newId, innerNewId });
    } else {
      newId = generateNodeId('detach');
    }
  }
  idMap.set(sourceId, newId);

  // Strip variant/animate-related entries — the clone is a free-standing
  // canvas node, not driven by the master's variants object. Layout-FLIP
  // props on motion elements stay (they're decorative and harmless at
  // canvas root).
  // Merge order: inline base, then variantOverride (variant wins, same
  // priority framer-motion uses at runtime). Skip empty/'auto' variant
  // values — the codebase's "empty = not set" convention.
  let styles: Record<string, string> = { ...src.styles };
  if (variantOverride) {
    for (const [k, v] of Object.entries(variantOverride)) {
      if (v !== undefined && v !== '' && v !== 'auto') styles[k] = v;
    }
  }
  // SOURCE-REPLICA EFFECTIVE STYLES (page-replica detach): overlay this node's
  // @media overrides for `sourceVpWidth` onto the base — the canvas node lives
  // outside the viewport tree so the per-viewport rules no longer cascade onto it;
  // bake the replica's resolved values in (e.g. tablet 2-col grid, not desktop
  // 3-col). Only applies to page replicas (`sourceVpWidth` set); component-variant
  // exits carry per-state values via the variant merge above.
  if (sourceVpWidth) {
    styles = resolveEffectiveStylesForViewport(styles, sourceId, sourceVpWidth, getDefaultStore().get(containerOverridesAtom));
  }
  // The clone is a PLAIN <div> canvas node — motion MOTION transform props
  // (rotate/scale/skew/x/y/…) carried over from the variant don't render as CSS
  // on a non-motion element (`rotate: '53'` is invalid CSS). Fold them into a
  // CSS `transform` string (same conversion the canvas Renderer does for motion
  // elements), drop the motion props, and clear any stale motion transform.
  const motionCss = motionPropsToCSSTransform(styles);
  for (const k of Object.keys(styles)) {
    if (MOTION_TRANSFORM_PROPS.has(k)) delete styles[k];
  }
  if (motionCss) styles.transform = motionCss;
  else delete styles.transform;
  // Strip inline `display: 'none'` ONLY when the source vp/variant was
  // making it visible via an override (the visible-on-source check at
  // the top of this function passed). Without the strip, the clone
  // would carry the inline `display: 'none'` and disappear on canvas
  // root (no @container/variant context to flip it visible). Nodes
  // hidden everywhere on the source vp/variant were already returned
  // `null` above, so we only reach here for visible nodes.
  if (styles.display === 'none') {
    delete styles.display;
  }

  // Resolve textContent against the source vp's text-overrides. A text
  // element authored on a non-primary vp uses
  // `{useResponsiveText('primary', { 768: 'tablet text' })}` where the
  // PRIMARY is often empty (zero-width-space) and the override holds the
  // real content. The parser stores primary in `textContent` and the
  // override map in `textOverrides`. Cloning verbatim would emit the
  // empty primary into the canvas-node, hiding the user's actual text.
  //
  // Resolve to what the source vp actually displays: pick the textOverride
  // matching the source vp's @media bucket if present, otherwise fall
  // back to primary textContent. This mirrors the renderer's per-vp
  // resolution logic (lowest matching width wins; vps fall back to
  // primary when no override exists).
  let resolvedTextContent = src.textContent;
  if (sourceVpWidth && src.textOverrides) {
    // Pick override key whose width matches the source vp. The hook's
    // bucket semantics: a vp at width X picks the LOWEST override key
    // >= X (mobile-first cascade). For our purposes, exact match is the
    // common case — the source vp's width is one of the breakpoints.
    const overrideKeys = Object.keys(src.textOverrides)
      .map(k => parseInt(k, 10))
      .filter(k => Number.isFinite(k))
      .sort((a, b) => a - b);
    const matched = overrideKeys.find(k => k >= sourceVpWidth) ?? overrideKeys[overrideKeys.length - 1];
    if (matched != null) {
      const override = src.textOverrides[String(matched)];
      // Only swap in the override if it's non-empty and meaningful (the
      // primary might be `​` zero-width space placeholder).
      if (override && override.trim() !== '' && override !== '​') {
        resolvedTextContent = override;
      }
    }
  }

  // Resolve VARIANT-conditional text: `{variant === 'variant-1' ? 'A' : 'B'}`
  // in a component file produces `src.conditionalText = { 'variant-1': 'A',
  // 'default': 'B' }`. When the user drags out from a specific variant
  // replica, the clone (which has no variant context at canvas root) must
  // bake in the text for THAT variant — otherwise it falls back to
  // `textContent` (= the `default` branch), which on the user's reported
  // case is the `​` zero-width placeholder, collapsing the element to 0px.
  //
  // Mapping: vpIdFromPrefix('') returns 'desktop' for the primary, but
  // the conditionalText map uses 'default' as the primary key (matching
  // the variantConfig). Translate desktop→default.
  if (sourceVariant && src.conditionalText) {
    const variantKey = sourceVariant === 'desktop' ? 'default' : sourceVariant;
    const variantText = src.conditionalText[variantKey];
    if (variantText && variantText.trim() !== '' && variantText !== '​') {
      resolvedTextContent = variantText;
    }
  }

  // Reorder children by the source vp's EFFECTIVE flex/grid order before
  // cloning. The JSX source order is the natural HTML order, but a
  // flex/grid parent may have per-vp `order: N` overrides in its
  // `@container` rules that change the visible order on the source vp
  // — e.g. text:0, shape:1, frame:2 even though the JSX is text→frame→
  // shape. The clone is a free-floating canvas-node with NO `@container`
  // context, so without pre-reordering the visible sequence on the
  // clone reverts to JSX order — not what the user saw at the moment
  // they dragged out. Read effective order = base inline `order` +
  // source-vp `@container` override (codebase-wide "''/'auto' = not
  // set" semantics), default 0.
  const overridesAtStart = sourceVpWidth ? getDefaultStore().get(containerOverridesAtom) : null;
  const readEffectiveOrder = (childId: string): number => {
    const childNode = nodes.get(childId);
    let raw = childNode?.styles?.order ?? '';
    if (sourceVpWidth && overridesAtStart) {
      const ovTree = overridesAtStart.get(childId)?.get(sourceVpWidth);
      const ovOrder = ovTree?.get('order');
      if (ovOrder !== undefined && ovOrder !== '' && ovOrder !== 'auto') raw = ovOrder;
    }
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  };
  const sortedChildIds = [...src.children].sort((a, b) => {
    const oa = readEffectiveOrder(a);
    const ob = readEffectiveOrder(b);
    // Stable: equal `order` keeps source-file (i.e. original `children`)
    // sequence — same tiebreak the browser flex algorithm uses.
    if (oa !== ob) return oa - ob;
    return src.children.indexOf(a) - src.children.indexOf(b);
  });

  const childDescriptors: import('@/code/generation/generator-crud').AddNodeDef[] = [];
  // A DESIGN component instance (e.g. <WoVuWo/>) is a LEAF on the canvas — its master
  // re-derives the internals at parse time from the instance tag + its props. Cloning
  // the EXPANDED internals (`instanceId:masterId` nodes) as real children produces a
  // broken double-render: the instance tag with its whole expanded tree injected inside
  // it (the reported drag-out bug). Skip ALL children for a design instance. Code/Code component
  // components (isCodeComponent) keep recursing — their children are real slot content.
  const isDesignInstanceRoot = !!src.isComponentInstance && !src.isCodeComponent;
  if (!isDesignInstanceRoot) {
    for (const childId of sortedChildIds) {
      const childNode = nodes.get(childId);
      if (!childNode) continue;
      // Skip expanded-component-instance internals (they live behind
      // boundary markers and re-derive at parse time from their master).
      if (childNode.componentInstanceId) continue;
      const childDescriptor = buildCanvasCloneDescriptor(childId, nodes, idMap, sourceVpWidth, sourceVariant);
      if (childDescriptor) childDescriptors.push(childDescriptor);
    }
  }

  // Carry framer-motion props (whileHover, whileTap, animate, …) onto the clone
  // so the animation isn't ERASED when the node is dragged out of a viewport —
  // the detached node stays a `motion.<tag>` with its hover/tap effect. Resolve
  // each prop to the value the SOURCE viewport actually shows, and bake THAT in
  // as the canvas node's (responsive-free) base: pick the `_chain` branch whose
  // media query covers `sourceVpWidth`. Dragging out of tablet → tablet's hover
  // override becomes the base; out of primary (no branch matches) → `_base`.
  // Markers (`_scope`/`_chain`/`_base`/`_variantName`) are stripped either way.
  let motionProps: Record<string, Record<string, string>> | undefined;
  if (src.motionProps) {
    const allWidths = getSortedBreakpointWidths();
    const resolveForVp = (p: Record<string, string>): Record<string, string> => {
      if ((p as any)._chain && sourceVpWidth) {
        try {
          const chain: Array<{ query?: string; props: Record<string, string> }> = JSON.parse((p as any)._chain);
          const hit = chain.find(e => e.query && queryToViewportSet(e.query, allWidths).includes(sourceVpWidth!));
          if (hit) return hit.props;             // source viewport's override → becomes the base
        } catch { /* fall through to _base */ }
      }
      if ((p as any)._base) { try { return JSON.parse((p as any)._base); } catch { /* fall through */ } }
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(p)) if (!k.startsWith('_') && v !== '') out[k] = v;
      return out;
    };
    for (const [name, raw] of Object.entries(src.motionProps as Record<string, any>)) {
      if (!raw || typeof raw !== 'object') continue;
      const resolved = resolveForVp(raw as Record<string, string>);
      if (Object.keys(resolved).length > 0) (motionProps ??= {})[name] = resolved;
    }
  }

  // A canvas clone is a free-standing MODULE-SCOPE node (`const canvasNodes = <>…</>`), so it has
  // none of the source's page-level hooks. Any style bound to the source's motion motion values —
  // the parser's `var:<id>` sentinel, e.g. `scale: 'var:frameXFxCScale'` — would reference an
  // undefined identifier, and so would a copied `ref={frameXRef}`. Drop both: the animation lives
  // on in the `data-instance-fx` / `data-scroll-variant` specs (kept in `attrs`), which regenerate
  // hooks for the clone's NEW id when it's dragged back into a viewport (rehydrate). This is the
  // dormant-clone equivalent of dormantizeInstanceFx for the move path.
  const cloneAttrs = src.attrs ? { ...src.attrs } : undefined;
  if (cloneAttrs) {
    delete cloneAttrs.ref;
    // Viewport-scoped contracts never travel to a canvas clone: a canvas
    // node has no replica to be solo on and no parent frame for pin
    // arithmetic. A copied `data-replica-solo` re-entered a replica as a
    // pre-soloed node and compounded per in/out cycle (the duplicated-attr
    // residue in the 2026-08-31 same-gesture trace).
    delete cloneAttrs['data-replica-solo'];
    delete cloneAttrs['data-pinned'];
    // BAKE THE SOURCE VARIANT. The instance's per-viewport variant choice lives in
    // `data-responsive` ({ "768": { initialVariant: "variant-1" }, … }), which only resolves
    // against a real viewport — a free canvas node has none, so it falls back to the BASE variant
    // (the bug: dragging out the tablet replica showed desktop's variant). Bake the variant the
    // source replica/variant actually displayed as an explicit `initialVariant` so the standalone
    // node keeps it. Page replica → look the source vp width up in data-responsive; component-variant
    // exit → use `sourceVariant` directly. (data-responsive is kept for a clean round-trip on
    // drag-back; on the viewport-less canvas the explicit `initialVariant` wins.)
    let bakedVariant: string | undefined;
    const respRaw = cloneAttrs['data-responsive'];
    if (sourceVpWidth && respRaw) {
      try { bakedVariant = JSON.parse(respRaw)?.[String(sourceVpWidth)]?.initialVariant; } catch { /* leave as-is */ }
    }
    if (!bakedVariant && sourceVariant && sourceVariant !== 'desktop') bakedVariant = sourceVariant;
    if (bakedVariant) cloneAttrs.initialVariant = bakedVariant;
    // A free canvas node has no viewport breakpoints, so `data-responsive` (the
    // per-viewport variant map) is meaningless here and only causes confusion — the
    // detached instance should be a clean, static instance whose variant is the baked
    // `initialVariant` (what the user saw when they dragged out). Strip it.
    delete cloneAttrs['data-responsive'];
  }

  // Attach the EFFECTIVE component variable(s) this node shows on the source variant
  // as a `data-var-orphan` stash. The clone bakes resolved literal style/text values
  // (above), so without this the variable is silently lost on a replica detach; the
  // parser reads the stash → same purple pill, and a drag-back rehydrates it. This is
  // the clone-path equivalent of the move-path `dormantizeComponentVarBindings`.
  // Pass the live code so a per-variant TRANSITION variable on this node is stashed too (it's not in the node model).
  const varOrphans = resolveVarOrphansForVariant(src, variantKey, projectFS.readFile(getActiveFilePath()) ?? '');
  const attrsWithOrphans = varOrphans.length > 0
    ? { ...(cloneAttrs ?? {}), 'data-var-orphan': serializeVarOrphanBindings(varOrphans) }
    : cloneAttrs;

  // A `{iter.field}` CMS text binding + a `url(${iter.field})` style binding can't
  // survive at module scope — dormantize BOTH (placeholder/url() + data-cms-orphan
  // Missing), like the move-path dormantize/heal.
  // CMS text binding for the dormantize: a per-variant binding
  // (`variantBindings.text[variantKey]`, e.g. variant-2 shows `item.role`) wins
  // over the base `node.binding` when baking that source variant; both leave
  // `textContent` EMPTY, so without a field the clone had empty text + no Missing pill.
  const variantTextBinding = variantKey ? src.variantBindings?.text?.[variantKey] : undefined;
  const cmsTextField = (variantTextBinding && 'field' in variantTextBinding)
    ? variantTextBinding.field
    : (src.binding?.property === 'text' ? src.binding.field : undefined);
  // Bake the ROW's resolved values over the dormant placeholders (copy-path
  // parity, user report 2026-07-28): the detached clone still shows the text /
  // image / attr it displayed in the list, while the stash keeps the "Missing"
  // pill + the re-entry re-bind.
  const { textContent: safeText, styles: safeStyles, attrs: safeAttrs } = bakeCmsValuesOnClone(dormantizeCloneBindings({
    textContent: resolvedTextContent || undefined,
    styles: dropDynamicStyleBindings(styles),
    attrs: attrsWithOrphans,
    textField: cmsTextField,
    attrBindings: src.attrBindings,
    styleBindings: src.styleBindings,
    propBindings: src.propBindings,
  }), resolveCmsRowValues(src, nodes));

  // FIT wrapper: the fit contract is `height: auto` — the viewBox owns the
  // aspect ratio and every re-fit rewrites it. A resolved FIXED height (the
  // drag strategy bakes px dims for canvas placement) freezes the box while
  // the aspect keeps changing → non-uniform/letterboxed text ("stretched"
  // live find 2026-07-03). Width px is fine (it defines the rendered size).
  if (src.type === 'svg' && newId.endsWith('-svg')) {
    safeStyles.height = 'auto';
  }

  return {
    id: newId,
    type: src.type,
    name: src.name,
    styles: safeStyles,
    attrs: safeAttrs,
    textContent: safeText,
    children: childDescriptors.length > 0 ? childDescriptors : undefined,
    motionProps,
  };
}

/** Drop any style whose value is the parser's `var:<id>` motion-value/ref sentinel. A canvas
 *  clone runs at module scope with no page hooks, so such a binding is a dead identifier. The
 *  animation is preserved via the clone's `data-instance-fx`/`data-scroll-variant` specs. */
export function dropDynamicStyleBindings(styles: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(styles)) {
    if (typeof v === 'string' && v.startsWith('var:')) continue;
    out[k] = v;
  }
  return out;
}
