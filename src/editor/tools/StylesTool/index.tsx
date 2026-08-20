// StylesTool — Pure composition of ToolAtoms. Zero inline control logic.
// Each atom is self-contained: reads its own value, handles binding detection,
// renders "Used by X" when scroll/animation bound, manages its own popup state.
//
// Some atoms render UNCONDITIONALLY (Fill, Radius, Padding, Margin, Overflow,
// Opacity, Hide, Border, Shadow, Transform) — they're staple controls every
// node may want to tweak. Others (OverflowX/Y, Mask, ClipPath, Filter,
// ZIndex, Pseudo) are DYNAMIC: they only show up when the underlying CSS
// property has a value somewhere on the node — directly, in a media-query
// override, or in a variant — so the panel doesn't drown the user in 20+
// rows of unused defaults. Currently-hidden dynamics surface in the Styles
// section's `+` dropdown for quick add.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { ToolSection } from '../../controls';
import { useControl } from '../../controls/ControlProvider';
import { isTextTag } from '@/shared/constants';
import { pseudoStylesAtom } from '@/code/stores/pseudo-store';
import { useNodesComputed } from '@/code/stores/node-family';
import { isVectorSetComponentFile } from '@/code/project/active-file-store';
import { trace } from '@/shared/debug-trace';
import {
  FillControl, RadiusControl, MarginControl,
  OverflowControl, OverflowXControl, OverflowYControl, OpacityControl, HideControl,
  BorderControl, ShadowControl, MaskControl,
  ClipPathControl, TransformControl, FilterControl, BackdropFilterControl, ZIndexControl,
  VariantTransitionControl, PseudoElementControl,
  PointerEventsControl, UserSelectControl,
  GroupFillControl, RotateControl,
} from './atoms';

// ─── Dynamic-style registry ─────────────────────────────────────────────────
//
// One entry per addable style. `keys` lists the CSS properties to check
// when deciding whether the row is already "set" on the node. `defaultStyles`
// is what the +-dropdown writes when the user picks the row — sensible
// no-ops or safe placeholders, chosen so the row appears with a recognisable
// preview the user can then refine. `requiresFrame` flags entries that
// only make sense on frame-like elements (Mask/ClipPath/Filter on text are
// noisy and the original code already gated them).
//
// NOTE: Pseudo is NOT in this registry — it has its own `pseudoStylesAtom`
// detection and the PseudoElementControl ships its own "Add ::before /
// Add ::after" affordance, so the row needs to render whenever a pseudo
// rule exists for the node, period.

interface DynamicStyleSpec {
  id: string;
  label: string;
  /** CSS properties any of which means "this style is in use on this node". */
  keys: string[];
  /** What to write when the user picks this from the +-dropdown. */
  defaultStyles: Record<string, string>;
  /** Hide on text nodes (matches the existing `!isText` gates). */
  requiresFrame?: boolean;
}

const DYNAMIC_STYLES: DynamicStyleSpec[] = [
  {
    id: 'overflowX',
    label: 'Overflow X',
    keys: ['overflowX'],
    // 'hidden' is the most common reason to set overflowX explicitly — visible
    // is already the default, so writing it would be a no-op.
    defaultStyles: { overflowX: 'hidden' },
  },
  {
    id: 'overflowY',
    label: 'Overflow Y',
    keys: ['overflowY'],
    defaultStyles: { overflowY: 'hidden' },
  },
  {
    id: 'mask',
    label: 'Mask',
    // Multiple keys because the Mask control reads several variants.
    keys: ['mask', 'maskImage', 'WebkitMask', 'WebkitMaskImage'],
    // Transparent → opaque vertical fade so the user immediately SEES a
    // mask effect when the row appears. The previous `black, black` default
    // was a no-op that left both gradient stops opaque — once parsed
    // through gradient-utils, every subsequent edit (rotation, stop drag)
    // re-emitted a black/black gradient, and the user could never make the
    // mask visible without manually replacing the value. Match
    // MaskControl.handleAdd's add-another-entry default so both entry
    // points produce the same visible starting gradient.
    defaultStyles: { maskImage: 'linear-gradient(0deg, rgba(0,0,0,0) 0%, rgb(0,0,0) 100%)', WebkitMaskImage: 'linear-gradient(0deg, rgba(0,0,0,0) 0%, rgb(0,0,0) 100%)' },
    requiresFrame: true,
  },
  {
    id: 'clipPath',
    label: 'Clip Path',
    keys: ['clipPath'],
    // `inset(0)` is the identity clip — clips nothing — so the row appears
    // visibly no-op until the user picks a real shape.
    defaultStyles: { clipPath: 'inset(0)' },
    requiresFrame: true,
  },
  {
    id: 'filter',
    label: 'Filter',
    keys: ['filter'],
    // `blur(0px)` renders identical to no filter — safe placeholder.
    defaultStyles: { filter: 'blur(0px)' },
  },
  {
    id: 'backdropFilter',
    label: 'Backdrop',
    // Both the standard and Safari-prefixed keys count as "in use", and the
    // control writes them together so they never drift apart.
    keys: ['backdropFilter', 'WebkitBackdropFilter'],
    // A visible frosted-glass blur so the effect is obvious the moment the
    // row is added (`blur(0px)` would render identical to no backdrop filter).
    defaultStyles: { backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' },
  },
  {
    id: 'zIndex',
    label: 'Z-Index',
    keys: ['zIndex'],
    // 0 is the default stacking context but writing it explicitly opts the
    // element into z-index participation, which is what the user asked for
    // by adding the row.
    defaultStyles: { zIndex: '0' },
  },
  {
    id: 'pointerEvents',
    label: 'Pointer',
    keys: ['pointerEvents'],
    // 'none' is the most common reason to set pointer-events explicitly —
    // makes the element pass through clicks. 'auto' is the default and
    // wouldn't change behaviour, so we add the meaningful one.
    defaultStyles: { pointerEvents: 'none' },
  },
  {
    id: 'userSelect',
    label: 'User Select',
    keys: ['userSelect'],
    // 'none' blocks text selection — common for buttons / chrome.
    defaultStyles: { userSelect: 'none' },
  },
];

// ─── StylesTool ────────────────────────────────────────────────────────────

export default function StylesTool() {
  const { node, styles, hasOverride, updateMultipleStyles } = useControl();
  const pseudoStyles = useAtomValue(pseudoStylesAtom);
  const isText = !!node && isTextTag(node.type);
  // SVG GROUP — a <svg> wrapper whose children are themselves <svg> shape
  // wrappers (vs a single-shape <svg> whose child is a polygon/path). A
  // group has no fill/border/radius of its own; its visible color lives on
  // each leaf shape's `fill` attr. So it gets a focused panel: Opacity +
  // group-Fill (fans out to every child, "Mixed" when they differ) + Hide +
  // Rotate — and skips the ~15 box-model rows that don't apply to a vector
  // group. Detected here (not in PropertiesPanel) so the Styles surface stays
  // self-describing: one tool, conditioned on what's selected.
  const isSvgGroup = useNodesComputed(
    (nodes) => !!node && node.type === 'svg' && Array.isArray(node.children)
      && node.children.some((cid) => nodes.get(cid)?.type === 'svg'),
    [node],
  );
  // The viewport frame (`root` on bare pages, `layout::root` on templated
  // pages) hides Margin + Hide: a viewport can't sit inside a flex/grid
  // parent (so margin doesn't paint), and hiding the page root would just
  // blank the canvas — neither control has a meaningful effect here.
  const isViewportFrame = !!node && (node.id === 'root' || node.id === 'layout::root');
  // Two related flags drive how the StylesTool collapses for component
  // instances. Both matter — see below.
  //
  //   - `isComponentInstanceWrapper` — the selected node IS the
  //     `<MyComponent />` JSX instance tag (top-level OR nested,
  //     stamped by `expandComponent` regardless of depth). For this
  //     case we render Opacity + Hide bound to the WRAPPER's own
  //     styles (the user can set wrapper-level overrides).
  //
  //   - `isInsideComponentInstance` — the selected node is an INNER
  //     element of an expansion (`componentInstanceId` points back to
  //     the wrapper). The styles on this node belong to the
  //     component's MASTER file, not to the consuming page; surfacing
  //     them here would let the user "edit" master content from the
  //     wrong file. Worse, the inner element legitimately carries
  //     `styleVariables` (the master's `style={{ opacity: opacity }}`
  //     resolved into a binding) — if we mount OpacityControl with
  //     this node, the row paints as a same-named purple pill that
  //     the user never created. Visible bug: after hoisting a prop on
  //     a nested instance, "opacity / hide" show as purple `T opacity`
  //     / `T hide` pills in the Styles section even though the user
  //     hoisted something totally different.
  //
  // The user is expected to select the WRAPPER itself (the visible
  // bounding box) to edit instance-level styles. Click redirection
  // already takes care of this for fresh clicks via
  // `redirectToComponentInstance`; this gate handles the case where
  // a stale `selectedId` left over from before a re-parse points at
  // an inner element.
  const isComponentInstanceWrapper = !!node && !!node.isComponentInstance;
  const isInsideComponentInstance = !!node && !isComponentInstanceWrapper && !!node.componentInstanceId;
  const isComponentInstance = isComponentInstanceWrapper || isInsideComponentInstance;
  // A VECTOR SET instance (imported icon/vector). It's an opaque, live-rendered
  // code component, NOT an expanded instance, so it gets the SAME stripped panel
  // as a component-instance wrapper PLUS a standalone Rotate: Opacity, Visible,
  // Rotate — no box-model (padding/radius/margin/border/shadow), no Transform
  // tool, no anchor (the vector fills its own aspect-locked box; those would just
  // fight the master). The + offers only the wrapper-safe extras.
  const isVectorSet = !!node && isVectorSetComponentFile(node.componentFile);

  // ─── Detection ────────────────────────────────────────────────────────
  // A style is considered "set on this node" when any of its candidate
  // CSS keys is present:
  //   1. in the resolved styles for the current viewport (covers direct
  //      base-state writes AND the active replica's @media override),
  //   2. via `hasOverride` (any breakpoint at all, even ones we're not
  //      currently viewing — switching tablet/mobile shouldn't make the
  //      row disappear),
  //   3. inside a variant override (component master files only).
  // We check 1+2+3 so the row stays visible regardless of which
  // viewport/variant the user is currently on — otherwise switching the
  // active viewport would yank the row from under their cursor.
  const hasStyleAnywhere = useCallback(
    (keys: string[]): boolean => {
      for (const k of keys) {
        if (styles[k]) return true;
        if (hasOverride(k)) return true;
        if (node?.motionVariants) {
          for (const variantStyles of Object.values(node.motionVariants)) {
            if (variantStyles[k]) return true;
          }
        }
      }
      return false;
    },
    [styles, hasOverride, node],
  );

  const visibleIds = useMemo(() => {
    const set = new Set<string>();
    for (const spec of DYNAMIC_STYLES) {
      if (spec.requiresFrame && isText) continue;
      if (hasStyleAnywhere(spec.keys)) set.add(spec.id);
    }
    return set;
  }, [hasStyleAnywhere, isText]);

  // Pseudo: detected via the pseudo-rules atom, which already keys by
  // node id. Either ::before or ::after counts.
  const hasPseudo = !!(node && pseudoStyles.get(node.id));

  // ─── +-dropdown picker ────────────────────────────────────────────────
  // Positioned via plain absolute (right-0 + top-full) inside a relative
  // wrapper — matches the AnimationTool's AddEffectDropdown so the menu
  // appears directly under the +, not as a portal'd panel that sits to the
  // far left of the screen.
  const [pickerOpen, setPickerOpen] = useState(false);
  // Flip the picker ABOVE the + when there isn't room below, and fade it in on
  // the next frame (opacity 0 → 1) so the off-screen flip never shows as a
  // position jump — same behaviour as AnimationTool's AddEffectDropdown.
  const [pickerDir, setPickerDir] = useState<'up' | 'down'>('down');
  const [pickerVisible, setPickerVisible] = useState(false);
  const pickerBtnRef = useRef<HTMLButtonElement>(null);

  // Component instances get a curated subset of dynamic styles in the +
  // dropdown — only ones that compose cleanly with the master's internal
  // styling because they target the wrapper / render layer, not the
  // visual primitives the master owns (no Fill, Radius, Padding, Border,
  // Shadow, Transform → those would fight the master).
  const COMPONENT_INSTANCE_ALLOWED = new Set([
    'filter', 'backdropFilter', 'mask', 'pointerEvents', 'userSelect', 'zIndex',
  ]);

  // Only the styles that are currently hidden are addable — we don't want
  // a dropdown entry that just re-writes a value the row already shows.
  const addableSpecs = useMemo(
    () => DYNAMIC_STYLES.filter(s => {
      if (s.requiresFrame && isText) return false;
      // Vector sets get the same curated + as component instances (no Fill,
      // Radius, Padding, Border, Shadow, Transform — only wrapper-safe extras).
      if ((isComponentInstance || isVectorSet) && !COMPONENT_INSTANCE_ALLOWED.has(s.id)) return false;
      return !visibleIds.has(s.id);
    }),
    [visibleIds, isText, isComponentInstance, isVectorSet],
  );
  // Component instances also don't get the Pseudo-element entry — pseudo
  // rules attach to the master's children, not the wrapper. Hide it from
  // the + when an instance is selected.
  const showPseudoEntry = !isComponentInstance && !isVectorSet && !hasPseudo;
  const showAddButton = addableSpecs.length > 0 || showPseudoEntry;

  // Measure on open: pick up/down by available space (the Styles + sits low in a
  // tall panel and its menu can hold many entries), position, THEN fade in.
  useEffect(() => {
    if (!pickerOpen) { setPickerVisible(false); return; }
    if (!pickerBtnRef.current) return;
    const rect = pickerBtnRef.current.getBoundingClientRect();
    const itemCount = addableSpecs.length + (showPseudoEntry ? 1 : 0);
    const menuHeight = Math.min(itemCount * 32 + 12, 360); // matches max-h below
    setPickerDir(window.innerHeight - rect.bottom >= menuHeight ? 'down' : 'up');
    requestAnimationFrame(() => setPickerVisible(true));
  }, [pickerOpen, addableSpecs.length, showPseudoEntry]);

  const handleAdd = useCallback(
    (spec: DynamicStyleSpec) => {
      trace.action('styles-tool:add-dynamic', { id: spec.id });
      updateMultipleStyles(spec.defaultStyles);
      setPickerOpen(false);
    },
    [updateMultipleStyles],
  );

  // Pseudo entry triggers the PseudoElementControl's own popup — but we
  // need to ensure the row is visible first. Easiest: write a no-op
  // ::before rule. The pseudo control then shows the row with that rule
  // and the user can configure it from there.
  const handleAddPseudo = useCallback(() => {
    if (!node) return;
    trace.action('styles-tool:add-pseudo', { nodeId: node.id });
    // Mutation: updatePseudoStyle with an empty content rule so the row
    // appears. The PseudoElementControl picks up the new rule via
    // pseudoStylesAtom on the next flush.
    import('@/code/mutation/mutation-queue').then(({ queueMutation }) => {
      queueMutation({
        type: 'updatePseudoStyle',
        nodeId: node.id,
        pseudo: 'before',
        styles: { content: '""' },
      });
    });
    setPickerOpen(false);
  }, [node]);

  // ─── SVG group ─────────────────────────────────────────────────────────
  // Focused panel: the four controls that actually mean something for a
  // vector group. No +-dropdown (the dynamic box-model styles below don't
  // apply). Opacity/Hide/Rotate reuse the shared atoms (they write CSS to
  // the group <svg> wrapper — the current group transform mechanism); Fill
  // fans out to every leaf shape via GroupFillControl.
  if (isSvgGroup) {
    trace.action('styles-tool:render-group', { nodeId: node!.id, childCount: node!.children?.length ?? 0 });
    return (
      <ToolSection title="Styles">
        <OpacityControl />
        <GroupFillControl />
        <HideControl />
        <RotateControl />
      </ToolSection>
    );
  }

  return (
    <ToolSection title="Styles" collapsible action={
      showAddButton ? (
        <div className="relative">
          <button
            ref={pickerBtnRef}
            onClick={(e) => { e.stopPropagation(); setPickerOpen(o => !o); trace.action('styles-tool:toggle-picker', { open: !pickerOpen }); }}
            className="flex items-center justify-end pl-[80px] -ml-[80px] cursor-pointer group text-[var(--text-primary)]"
            title="Add style"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-opacity group-hover:opacity-80">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>

          {/* Dropdown anchored to the +'s right edge, sitting just below
              it — exactly the same shape AnimationTool's AddEffectDropdown
              uses (absolute right-0 + top-full). Backdrop is fixed so a
              click anywhere else closes it. */}
          {pickerOpen && (
            <>
              <div className="fixed inset-0 z-[10000]" onClick={() => setPickerOpen(false)} />
              <div
                className={`absolute right-[10px] ${pickerDir === 'up' ? 'bottom-full mb-1' : 'top-full mt-1'} bg-[var(--dropdown-bg)] shadow-[var(--shadow-lg)] cut-corners cut-lg cut-border [--cut-border-color:var(--border-light)] py-1.5 z-[10001] w-max max-h-[360px] overflow-y-auto border border-[var(--border-light)] space-y-0.5 transition-opacity duration-150`}
                style={{ opacity: pickerVisible ? 1 : 0, scrollbarWidth: 'none' }}
              >
                {addableSpecs.length === 0 && !showPseudoEntry && (
                  <div className="px-3 py-2 text-xs text-[var(--text-disabled)]">
                    All styles already added
                  </div>
                )}
                {addableSpecs.map(spec => (
                  <button
                    key={spec.id}
                    onClick={() => handleAdd(spec)}
                    className="group flex items-center mx-1.5 px-2.5 py-1.5 cut-corners w-[calc(100%-12px)] text-left cursor-pointer whitespace-nowrap hover:bg-[var(--accent)] transition-colors"
                  >
                    <span className="text-xs font-medium text-[var(--text-primary)] group-hover:text-[var(--accent-fg)]">
                      {spec.label}
                    </span>
                  </button>
                ))}
                {showPseudoEntry && (
                  <button
                    onClick={handleAddPseudo}
                    className="group flex items-center mx-1.5 px-2.5 py-1.5 cut-corners w-[calc(100%-12px)] text-left cursor-pointer whitespace-nowrap hover:bg-[var(--accent)] transition-colors"
                  >
                    <span className="text-xs font-medium text-[var(--text-primary)] group-hover:text-[var(--accent-fg)]">
                      Pseudo Element
                    </span>
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      ) : null
    }>
      {/* Component instances get a stripped-down panel: only the two
          wrapper-level styles that compose cleanly with whatever the
          master defines. Everything else — Fill, Radius, Padding,
          Margin, Overflow, Border, Shadow, Transform, Filter, etc. —
          belongs inside the component's own master file. */}
      {isInsideComponentInstance ? (
        // Selected node is INNER content of an expansion. Don't render
        // any rows — those styles belong to the component's master
        // file and surfacing them here would (a) edit master content
        // from the wrong file and (b) paint same-named purple pills
        // sourced from the inner element's `styleVariables` markers
        // (the master's prop bindings). The user is expected to click
        // the component's bounding box (the wrapper) to edit
        // instance-level styles — `redirectToComponentInstance`
        // handles that for fresh clicks; this branch just refuses to
        // surface the inner element's styles.
        null
      ) : (isComponentInstanceWrapper || isVectorSet) ? (
        // Wrapper-level styles only — Margin, Opacity and Hide are always
        // visible; the rest (Filter, Mask, Pointer Events, User Select,
        // Z-Index) appear once the user adds them via the +. Each is
        // gated on `visibleIds` so they hide again when removed, same
        // as for non-instance nodes. A VECTOR SET additionally gets a
        // standalone Rotate (no full Transform tool / anchor).
        //
        // MARGIN belongs here even though PADDING does not: margin is the
        // OUTER box, owned by the parent's flow, so an instance override
        // composes cleanly with whatever the master paints inside. Padding
        // is the inner box and is the master's to own. The instance already
        // exposes its other outer-box props (size, align-self, grid span)
        // via the Size and Layout tools, and codegen writes marginTop onto
        // an instance without complaint — leaving it out of this branch just
        // meant hand-written margins rendered on canvas but were invisible
        // and uneditable in the panel.
        <>
          <MarginControl />
          <OpacityControl />
          <HideControl />
          {isVectorSet && <RotateControl />}
          {visibleIds.has('mask') && <MaskControl />}
          {visibleIds.has('filter') && <FilterControl />}
          {visibleIds.has('backdropFilter') && <BackdropFilterControl />}
          {visibleIds.has('zIndex') && <ZIndexControl />}
          {visibleIds.has('pointerEvents') && <PointerEventsControl />}
          {visibleIds.has('userSelect') && <UserSelectControl />}
        </>
      ) : (
        <>
          <VariantTransitionControl />
          {!isText && <FillControl />}
          {!isText && <RadiusControl />}
          {/* Padding moved to the Layout tool (after Gap): an element only has
              an inner content box to pad when it has a flex/grid layout, so it
              lives under Layout (design-tool parity), not here. */}
          {!isViewportFrame && <MarginControl />}
          <OverflowControl />
          {visibleIds.has('overflowX') && <OverflowXControl />}
          {visibleIds.has('overflowY') && <OverflowYControl />}
          <OpacityControl />
          {!isViewportFrame && <HideControl />}
          <BorderControl />
          {!isText && <ShadowControl />}
          {!isText && visibleIds.has('mask') && <MaskControl />}
          {!isText && visibleIds.has('clipPath') && <ClipPathControl />}
          <TransformControl />
          {visibleIds.has('filter') && <FilterControl />}
          {visibleIds.has('backdropFilter') && <BackdropFilterControl />}
          {visibleIds.has('zIndex') && <ZIndexControl />}
          {visibleIds.has('pointerEvents') && <PointerEventsControl />}
          {visibleIds.has('userSelect') && <UserSelectControl />}
          {hasPseudo && <PseudoElementControl />}
        </>
      )}
    </ToolSection>
  );
}
