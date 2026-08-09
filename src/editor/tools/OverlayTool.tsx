// OverlayTool.tsx — Overlay management in PropertiesPanel.
// Create/configure overlays on selected element, or show overlay-specific controls.

import { useCallback, useState, useRef, useEffect } from 'react';
import { useAtomValue, useAtom } from 'jotai';
import { LocalizeGate } from '@/editor/controls/localize-gate';
import { ToolSection, ToolSelect, ToolSegmentedControl, ToolInput, ToolDivider, ControlLabel, ControlActionRow, RemoveButton, ColorInput } from '../controls';
import ToolPopup from '../ui/ToolPopup';
import TransitionPanel from './AnimationTool/TransitionPanel';
import { TransitionCurveIcon, summarizeTransition } from './AnimationTool/CurvePreview';
import { useControl } from '../controls/ControlProvider';
import { overlayCallsAtom, overlayTriggerCallsAtom, overlayEditingIdAtom } from '@/code/stores/overlay-store';
import { getOverlayForNode, getTriggerForNode, resolveOverlayConfig, parseOverlayTriggerCalls, type OverlayCall, type OverlayTriggerCall } from '@/code/parsing/overlay-parser';
import { queueMutation, flushNow, getCurrentCode } from '@/code/mutation/mutation-queue';
import { stateVarName } from '@/code/generation/overlay-gen';
import { selectedIdsAtom, nodesAtom, isComponentFileAtom, isLayoutFileAtom } from '@/code/stores/store';
import { useNodesComputed } from '@/code/stores/node-family';
import { interactingViewportIdAtom, viewportWidthsAtom } from '@/code/stores/viewport-store';
import { isPrimaryViewport, getViewportPrefix } from '@/canvas/node-ops';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { projectFS } from '@/code/project/project-fs';
import { parseVariantConfig } from '@/code/variants/variant-config';
import { buildComponentRegistry } from '@/code/components/component-registry';
import type { OverlayConfig, OverlayConfigOverride, OverlayTriggerConfig } from '@/shared/types';
import { trace } from '@/shared/debug-trace';

const POSITION_OPTIONS = [
  { value: 'bottom', label: 'Bottom' },
  { value: 'top', label: 'Top' },
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
];

// Align icons — bar (trigger edge) + box (overlay) in start/center/end
// arrangements, matching the Position tool's icon language.
const AlignStartIcon = (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <rect x="1.5" y="2" width="1.5" height="10" rx="0.75" fill="currentColor" />
    <rect x="5" y="4.5" width="7" height="5" rx="1" fill="currentColor" />
  </svg>
);
const AlignCenterIcon = (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <rect x="6.25" y="2" width="1.5" height="2" rx="0.75" fill="currentColor" />
    <rect x="6.25" y="10" width="1.5" height="2" rx="0.75" fill="currentColor" />
    <rect x="3.5" y="4.5" width="7" height="5" rx="1" fill="currentColor" />
  </svg>
);
const AlignEndIcon = (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <rect x="11" y="2" width="1.5" height="10" rx="0.75" fill="currentColor" />
    <rect x="2" y="4.5" width="7" height="5" rx="1" fill="currentColor" />
  </svg>
);

const ALIGN_OPTIONS = [
  { value: 'start', icon: AlignStartIcon },
  { value: 'center', icon: AlignCenterIcon },
  { value: 'end', icon: AlignEndIcon },
];

const TRIGGER_OPTIONS = [
  { value: 'click', label: 'Click' },
  { value: 'hover', label: 'Hover' },
];

// Dismiss is intentionally two-state (standard): Auto = click outside (and
// Escape) closes it; Click = only re-clicking the trigger closes it. The legacy
// 'escape' value reads as Auto.
const DISMISS_OPTIONS = [
  { value: 'outside', label: 'Auto' },
  { value: 'click', label: 'Click' },
];

const COLLISION_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'none', label: 'None' },
];

const DISMISSIBLE_OPTIONS = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];

const PAGE_SCROLL_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'block', label: 'Block' },
];

const DEFAULT_FIXED_FILL = 'rgba(0,0,0,0.5)';

let overlayIdCounter = 0;
/**
 * A fresh overlay id for `triggerId`.
 *
 * The counter alone is NOT unique: it lives at MODULE scope and restarts at 0 on
 * every editor load, so the first overlay of a new session on a trigger that
 * already had one handed back the SAME id. The generator then re-declared that
 * id's `const [<id>Open, set…] = useState(false)` — a hard SyntaxError
 * ("Identifier has already been declared") that parses the page to ZERO nodes
 * and blanks the whole canvas (live find 2026-07-25, "I recreate modal overlay,
 * my page completely crashes").
 *
 * So probe the LIVE code (pending mutations included) and skip any id whose
 * element OR state variable is still present — orphan runtime left behind by a
 * half-completed removal counts as taken too. `createOverlayInCode` is idempotent
 * about the same declarations as a second line of defence.
 */
function generateOverlayId(triggerId: string): string {
  let code = '';
  try { code = getCurrentCode(); } catch { /* no active file (tests) — counter only */ }
  for (let attempt = 0; attempt < 500; attempt++) {
    overlayIdCounter++;
    const id = `overlay-${triggerId}-${overlayIdCounter}`;
    const taken = !!code && (code.includes(`data-id="${id}"`) || code.includes(stateVarName(id)));
    if (!taken) {
      trace.action('overlay-tool:generate-id', { triggerId, id, counter: overlayIdCounter, attempt });
      return id;
    }
  }
  trace.error('overlay-tool:generate-id-exhausted', { triggerId, counter: overlayIdCounter });
  return `overlay-${triggerId}-${overlayIdCounter}`;
}

export default function OverlayTool() {
  const { node, nodeId } = useControl();
  const allOverlays = useAtomValue(overlayCallsAtom);
  const allTriggers = useAtomValue(overlayTriggerCallsAtom);
  const [editingOverlayId, setEditingOverlayId] = useAtom(overlayEditingIdAtom);
  const setSelectedIds = useAtom(selectedIdsAtom)[1];

  // NO NESTED OVERLAYS: if this node sits ANYWHERE inside an existing overlay's
  // subtree (fixed or relative, at any depth), you can't attach a new overlay to
  // it — the Overlays control is disabled. Walk the parent chain for an overlay
  // ancestor (an overlay's data-id is the overlayId of some overlay call).
  // (Hook — so it lives ABOVE the null-node early return.)
  const isInsideOverlay = useNodesComputed((nodes) => {
    const overlayIdSet = new Set(allOverlays.map(o => o.overlayId));
    let cur = node?.parentId ? nodes.get(node.parentId) : undefined;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      if (overlayIdSet.has(cur.id)) return true;
      seen.add(cur.id);
      cur = cur.parentId ? nodes.get(cur.parentId) : undefined;
    }
    return false;
  }, [node, allOverlays]);

  // Overlay-mode visuals (show the edited overlay + dim viewports) are managed
  // at the Canvas level — NOT here — so they survive this tool unmounting when
  // the user clicks empty canvas mid-edit. See Canvas.tsx.

  if (!node || !nodeId) return null;

  // Check if this node IS a trigger (has overlay attached)
  const triggerInfo = getTriggerForNode(allTriggers, nodeId);
  // Check if this node IS an overlay
  const overlayInfo = getOverlayForNode(allOverlays, nodeId);

  const hasOverlay = !!triggerInfo;
  const isOverlay = !!overlayInfo;
  const isEditingOverlay = editingOverlayId !== null;

  trace.fn('OverlayTool:render', { nodeId, hasOverlay, isOverlay, isEditingOverlay, isInsideOverlay });

  // NO NESTED OVERLAYS: a node sitting inside an overlay can't host one, so HIDE
  // the entire Overlays tool from the properties panel. (An overlay node itself
  // is never "inside" another — `isInsideOverlay` only walks ANCESTORS — so its
  // own Show On / Overlay controls below are unaffected.)
  if (isInsideOverlay) return null;

  // Overlay selected — standard panel: "Show On" (how it opens, what
  // triggers it) above "Overlay" (where it lands). No exit button anywhere;
  // the viewport header is the exit affordance (accent bar + Done).
  if (isOverlay && overlayInfo) {
    return (
      <>
        <ToolSection title="Show On" collapsible>
          <ShowOnControls overlayId={nodeId} overlayConfig={overlayInfo.config}
            allTriggers={allTriggers} />
        </ToolSection>
        <ToolDivider />
        <ToolSection title="Overlay" collapsible>
          <OverlayControls nodeId={nodeId} overlayConfig={overlayInfo.config} allTriggers={allTriggers} />
        </ToolSection>
      </>
    );
  }

  return (
    <LocalizeGate hidden>
      <ToolSection title="Overlays" collapsible
        hasContent={hasOverlay}
        action={!hasOverlay ? <OverlayAddButton nodeId={nodeId} onCreated={(overlayId) => {
          // `handleCreate` already flushed synchronously, so the overlay node is in
          // the atom NOW — select + enter edit mode in the same batch for an
          // instant (single-render) select, no post-parse setTimeout blink.
          setEditingOverlayId(overlayId);
          setSelectedIds([overlayId]);
        }} /> : undefined}>
        {/* Node is a trigger — ONE compact standard row: the interaction
            event as the label, an "Overlay" swatch pill that opens overlay edit
            mode, and an × to remove. All configuration (Show On, Position,
            Dismiss…) lives on the overlay selection itself. */}
        {hasOverlay && triggerInfo ? (
          <div className="flex flex-col gap-2">
            <TriggerOverlayRow nodeId={nodeId} triggerInfo={triggerInfo} allOverlays={allOverlays}
              setEditingOverlayId={setEditingOverlayId} setSelectedIds={setSelectedIds} />
            {/* Source is a component INSTANCE → "On Open: Set Variant" (null otherwise). */}
            <OnOpenVariantRow overlayId={triggerInfo.config.targetId} instanceNodeId={nodeId} />
          </div>
        ) : (
          // Empty state: no overlay/trigger yet. `ToolSection` returns null when
          // it has zero valid children, which would hide the whole section —
          // including the `+` action used to CREATE an overlay. A sentinel child
          // (never painted, since hasContent=false hides the body) keeps the
          // header + `+` visible. Same approach as TemplatePicker / LayoutTool.
          <span aria-hidden="true" />
        )}
      </ToolSection>
      {/* Trailing divider so the next section (Component / Cursor / Styles…) is
          separated from Overlays — lives INSIDE the tool so it's skipped when the
          tool renders null (node inside an overlay). */}
      <ToolDivider />
    </LocalizeGate>
  );
}

// ─── Trigger row — "Hover | [▣ Overlay ×]" ──────────────────────────────────

// The glyph sits ON the accent fill, so it takes `--accent-fg` — the per-theme
// answer to exactly that (globals.css: "white on it only reaches 4.0, so
// --accent-fg is near-black"). It was hard-coded white plus `currentColor`,
// which inherited the row's light text: near-invisible on the default clay
// accent (user report 2026-08-10). The back square keeps its 55% tint, now as
// a lighter pass of the same colour rather than a different one.
const OverlayPillIcon = (
  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] bg-[var(--accent)]">
    <svg width="11" height="11" viewBox="0 0 14 14" fill="none">
      <rect x="2" y="2" width="8" height="8" rx="1.5" fill="var(--accent-fg)" fillOpacity="0.55" />
      <rect x="5" y="5" width="8" height="8" rx="1.5" fill="var(--accent-fg)" />
    </svg>
  </span>
);

function TriggerOverlayRow({ nodeId, triggerInfo, allOverlays, setEditingOverlayId, setSelectedIds }: {
  nodeId: string;
  triggerInfo: OverlayTriggerCall;
  allOverlays: OverlayCall[];
  setEditingOverlayId: (id: string | null) => void;
  setSelectedIds: (ids: string[]) => void;
}) {
  const overlayId = triggerInfo.config.targetId;
  const overlayExists = !!getOverlayForNode(allOverlays, overlayId);
  const label = triggerInfo.config.trigger === 'hover' ? 'Hover' : 'Click';

  const handleRemove = useCallback(() => {
    queueMutation({ type: 'removeOverlay', overlayId, triggerId: nodeId });
    trace.action('overlay-tool:remove', { nodeId, overlayId });
  }, [nodeId, overlayId]);

  if (!overlayExists) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-[10px] text-red-400">Overlay missing — was it deleted?</span>
        <button
          onClick={handleRemove}
          className="w-full h-7 flex items-center justify-center text-[11px] text-red-400 hover:text-red-300 bg-red-500/10 border border-red-500/20 rounded-[var(--radius-lg)] cursor-pointer transition-colors"
        >
          Remove Broken Trigger
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between w-full">
      <ControlLabel label={label} property="" plain />
      <ControlActionRow
        className="justify-between"
        onClick={() => {
          setEditingOverlayId(overlayId);
          setSelectedIds([overlayId]);
          trace.action('overlay-tool:enter-mode', { overlayId });
        }}
      >
        <span className="flex min-w-0 items-center gap-2">
          {OverlayPillIcon}
          <span className="truncate text-xs">Overlay</span>
        </span>
        <RemoveButton onClick={handleRemove} />
      </ControlActionRow>
    </div>
  );
}

// ─── Show On (overlay selection) ────────────────────────────────────────────
// How the overlay opens: Interaction (Click / Hover), stored on the trigger's
// config. (No Trigger-element row — the reference reserves that slot for A/B-test
// style triggers, which we don't have yet.)

/** Variant names of the master component a given instance node points at (empty
 *  for a non-instance / no-variant component). */
function getInstanceVariantNames(triggerId: string, nodes: ReturnType<typeof useAtomValue<typeof nodesAtom>>): string[] {
  const tn = nodes.get(triggerId);
  if (!tn?.componentFile) return [];
  try {
    const code = projectFS.readFile(tn.componentFile);
    if (!code) return [];
    return parseVariantConfig(code).map(v => v.name);
  } catch { return []; }
}

/** Event prop names declared on the trigger's component-instance master (varType
 *  'event'). Empty when the trigger isn't a component instance. */
function getInstanceEventNames(triggerId: string, nodes: ReturnType<typeof useAtomValue<typeof nodesAtom>>): Array<{ name: string; label: string }> {
  const tn = nodes.get(triggerId);
  if (!tn?.componentFile) return [];
  try {
    const reg = buildComponentRegistry(projectFS);
    for (const info of reg.values()) if (info.filePath === tn.componentFile) {
      // `name` = the prop identifier (wired in code); `label` = the friendly
      // @propMeta display name the user renamed it to.
      return info.props.filter(p => p.varType === 'event').map(p => ({ name: p.name, label: p.label ?? p.name }));
    }
    return [];
  } catch { return []; }
}

function ShowOnControls({ overlayId, overlayConfig, allTriggers }: {
  overlayId: string;
  overlayConfig: OverlayConfig;
  allTriggers: OverlayTriggerCall[];
}) {
  const triggerInfo = getTriggerForNode(allTriggers, overlayConfig.triggerId);
  // A component-instance trigger exposes its component EVENTS here, so an overlay
  // can be opened by an event fired from INSIDE the component (e.g. a child's click).
  const eventNames = useNodesComputed(
    (nodes) => getInstanceEventNames(overlayConfig.triggerId, nodes),
    [overlayConfig.triggerId],
  );

  const updateInteraction = useCallback((v: string) => {
    if (!triggerInfo) return;
    // `event:<name>` selects a component event; plain values are click/hover.
    const config = v.startsWith('event:')
      ? { ...triggerInfo.config, trigger: 'event' as const, eventName: v.slice(6) }
      : { ...triggerInfo.config, trigger: v as 'click' | 'hover', eventName: undefined };
    queueMutation({ type: 'updateOverlayTrigger', triggerId: overlayConfig.triggerId, config });
    trace.action('overlay-tool:update-interaction', { overlayId, trigger: v });
  }, [triggerInfo, overlayConfig.triggerId, overlayId]);

  const options = [
    ...TRIGGER_OPTIONS,
    ...eventNames.map(e => ({ value: `event:${e.name}`, label: e.label })),
  ];
  const value = triggerInfo?.config.trigger === 'event' && triggerInfo.config.eventName
    ? `event:${triggerInfo.config.eventName}`
    : (triggerInfo?.config.trigger ?? 'click');

  return (
    <div className="flex items-center justify-between w-full">
      <ControlLabel label="Interaction" property="" plain />
      <div className="w-full">
        <ToolSelect value={value} onChange={updateInteraction} options={options} />
      </div>
    </div>
  );
}

/** "On Open: Set Variant" row — shown on the SOURCE instance's Overlays section
 *  (next to the trigger pill) when the trigger is a component instance. Writes
 *  the OVERLAY's config `onOpenVariant` (the instance switches to it while open,
 *  reverts on close).
 *
 *  RESPONSIVE: like the position fields, `onOpenVariant` is overridable per page
 *  REPLICA viewport (`config.responsive[width]`) and per design-component VARIANT
 *  (`config.responsiveVariant[name]`). On the primary viewport we write the base;
 *  on a replica/variant we write an override and show a blue reset dot. The
 *  displayed value is the RESOLVED value for the current viewport/variant. */
function OnOpenVariantRow({ overlayId, instanceNodeId }: { overlayId: string; instanceNodeId: string }) {
  const allOverlays = useAtomValue(overlayCallsAtom);
  const interactingVpId = useAtomValue(interactingViewportIdAtom);
  const vpWidths = useAtomValue(viewportWidthsAtom);
  const isComponentFile = useAtomValue(isComponentFileAtom);
  const variantNames = useNodesComputed(
    (nodes) => getInstanceVariantNames(instanceNodeId, nodes),
    [instanceNodeId],
  );
  const overlayCfg = getOverlayForNode(allOverlays, overlayId)?.config;

  const isPrimary = isPrimaryViewport(interactingVpId);
  const vpWidth = vpWidths[interactingVpId] ?? 0;
  // A non-primary design-component VARIANT is the replica analog of a page's
  // non-primary viewport — keyed by variant NAME, not a width.
  const variantKey = isComponentFile && !isPrimary ? interactingVpId : null;
  const override: OverlayConfigOverride = !overlayCfg || isPrimary ? {}
    : variantKey ? (overlayCfg.responsiveVariant?.[variantKey] || {})
    : (overlayCfg.responsive?.[String(vpWidth)] || {});
  const resolved = override.onOpenVariant !== undefined ? override.onOpenVariant : (overlayCfg?.onOpenVariant ?? '');
  const overridden = !isPrimary && override.onOpenVariant !== undefined;

  const breakpoints = Object.values(vpWidths);
  const update = useCallback((v: string) => {
    queueMutation({ type: 'updateOverlayConfig', overlayId, patch: { onOpenVariant: v },
      vpWidth: variantKey ? null : (isPrimary ? null : vpWidth), breakpoints, variant: variantKey });
    flushNow();
    trace.action('overlay-tool:update-on-open-variant', { overlayId, variant: v, vpWidth: isPrimary ? null : vpWidth, variantKey });
  }, [overlayId, isPrimary, vpWidth, variantKey, breakpoints]);
  const reset = useCallback(() => {
    queueMutation({ type: 'updateOverlayConfig', overlayId, patch: {},
      vpWidth: variantKey ? null : vpWidth, resetKeys: ['onOpenVariant'], breakpoints, variant: variantKey });
    flushNow();
    trace.action('overlay-tool:reset-on-open-variant', { overlayId, vpWidth, variantKey });
  }, [overlayId, vpWidth, variantKey, breakpoints]);

  if (variantNames.length === 0) return null;
  return (
    <div className="flex items-center justify-between w-full">
      <ControlLabel label="On Open" property="" plain overridden={overridden} onResetOverride={reset} />
      <div className="w-full">
        <ToolSelect
          value={resolved}
          onChange={update}
          options={[{ value: '', label: 'Set Variant…' }, ...variantNames.map(n => ({ value: n, label: n }))]}
        />
      </div>
    </div>
  );
}

// ─── Add Button (+ dropdown in section header) ──────────────────────────────

function OverlayAddButton({ nodeId, onCreated }: { nodeId: string; onCreated?: (overlayId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [openDir, setOpenDir] = useState<'up' | 'down'>('down');
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Flip the menu ABOVE the trigger when there isn't room below — same rule as
  // the other properties-panel dropdowns (AddEffectDropdown). The Overlays row
  // sits low in a tall panel, so a downward menu clipped off-screen. The menu
  // is mounted at opacity 0, positioned (openDir set), THEN faded in on the next
  // frame — same slight fade as AddEffectDropdown — so the off-screen flip never
  // shows as an ugly position jump.
  useEffect(() => {
    if (!open) { setVisible(false); return; }
    if (!btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const MENU_HEIGHT = 150; // two options + descriptions
    setOpenDir(window.innerHeight - rect.bottom >= MENU_HEIGHT ? 'down' : 'up');
    requestAnimationFrame(() => setVisible(true));
  }, [open]);
  const isComponentFile = useAtomValue(isComponentFileAtom);
  // isComponentFileAtom is component-LIKE (true for design components AND
  // templates). A TEMPLATE (LayoutClient) is page dialect, not a reusable
  // component box — it has its own data-id="root" and supports viewport-fixed
  // overlays (e.g. a fixed mobile menu opened from the header). So separate it
  // from real design components when deciding whether a Modal is offerable.
  const isTemplateFile = useAtomValue(isLayoutFileAtom);

  // A trigger is "canvas-rooted" when it's a canvas node or sits inside one.
  // Such triggers can ONLY host a relative (dropdown/popover) overlay — a
  // full-screen modal makes no sense on the canvas — so we skip the type
  // chooser and build the overlay directly in `canvasNodes`.
  const isCanvasRooted = useNodesComputed((nodes) => {
    let cur = nodes.get(nodeId);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      if (cur.isCanvasNode) return true;
      seen.add(cur.id);
      cur = cur.parentId ? nodes.get(cur.parentId) : undefined;
    }
    return false;
  }, [nodeId]);

  // Skip the Dropdown/Modal chooser and create a Dropdown directly when the
  // trigger is canvas-rooted OR we're inside a REAL design component. A
  // full-screen Modal is a page-level concept (it needs a real route/viewport
  // to cover); inside a component a trigger only ever wants a relative dropdown,
  // same as on the canvas — so go straight to it instead of offering an unusable
  // Modal. Templates are EXCLUDED: they're page dialect (own data-id="root"),
  // so a fixed Modal is valid there (e.g. a fixed menu from the header) — show
  // the chooser so both Dropdown and Modal are offered.
  const skipChooser = isCanvasRooted || (isComponentFile && !isTemplateFile);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const handleCreate = useCallback((type: 'relative' | 'fixed') => {
    // STALE-ATOM GUARD: during an undo/redo canvas-first restore, codeAtom —
    // and the overlay atoms this panel renders from — lag the committed file
    // by up to ~300ms (setCode fan-out 250ms + version bump 300ms), so this
    // "+" can be showing although the trigger ALREADY has an overlay. Every
    // click in that window minted a NEW overlay (-2, -3, … — the id counter
    // is monotonic and each create is its own history entry), which the user
    // experienced as "undo/redo keeps adding overlays" (trace 2026-08-05).
    // The queue's currentCode is authoritative at any instant — re-check the
    // trigger there and re-open the EXISTING overlay instead of twinning it.
    try {
      const existing = parseOverlayTriggerCalls(getCurrentCode())
        .find((t) => t.triggerId === nodeId);
      if (existing) {
        trace.action('overlay-tool:create-skip-existing', { nodeId, existingId: existing.config.targetId });
        setOpen(false);
        onCreated?.(existing.config.targetId);
        return;
      }
    } catch { /* no active file (tests) — proceed with create */ }
    const overlayId = generateOverlayId(nodeId);
    const overlayConfig: OverlayConfig = {
      type,
      triggerId: nodeId,
      side: 'bottom',
      align: 'center',
      offsetX: 0,
      offsetY: 10,
    };
    const triggerConfig: OverlayTriggerConfig = {
      targetId: overlayId,
      trigger: 'click',
      dismiss: 'outside',
    };
    queueMutation({ type: 'createOverlay', triggerId: nodeId, overlayId, overlayConfig, triggerConfig, canvasNode: isCanvasRooted });
    // Flush SYNCHRONOUSLY so the overlay node exists in the parse/atom THIS tick —
    // the caller can then select it in the same React batch (no staggered
    // create-then-select). Without this the create flushed async and selection
    // had to be delayed behind a setTimeout, which read as a two-step blink.
    flushNow();
    // The default Appear (enter `initial→animate` + `exit`, wrapped in
    // <AnimatePresence>) is baked into the overlay codegen for relative viewport
    // overlays — no separate updateMotionProp needed. Canvas overlays are static
    // editor-only metadata (never executed), so they get no animation props.
    trace.action('overlay-tool:create', { nodeId, overlayId, type, canvasNode: isCanvasRooted });
    setOpen(false);
    onCreated?.(overlayId);
  }, [nodeId, isCanvasRooted]);

  return (
    <div className="relative" ref={ref}>
      <button
        ref={btnRef}
        onClick={() => (skipChooser ? handleCreate('relative') : setOpen(!open))}
        className="flex items-center justify-end pl-[80px] -ml-[80px] cursor-pointer group text-[var(--text-primary)]"
        title={skipChooser ? 'Add dropdown' : 'Add overlay'}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-opacity group-hover:opacity-80">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setOpen(false)} />
          <div className={`absolute right-0 ${openDir === 'up' ? 'bottom-full mb-1' : 'top-full mt-1'} bg-[var(--dropdown-bg)] shadow-md rounded-[var(--radius-md)] py-1.5 z-[51] w-max border border-[var(--border-light)] transition-opacity duration-150`}
            style={{ opacity: visible ? 1 : 0 }}>
            <button type="button"
              className="group flex flex-col gap-0.5 mx-1.5 px-2.5 py-1.5 rounded w-[calc(100%-12px)] text-left cursor-pointer bg-transparent hover:!bg-[var(--accent)] border-none"
              onClick={() => handleCreate('relative')}>
              <div className="text-xs font-medium text-[var(--text-primary)] group-hover:text-[var(--accent-fg)]">Dropdown</div>
              <div className="text-[11px] text-[var(--text-secondary)] group-hover:text-[var(--accent-fg)]/80">Positioned near trigger</div>
            </button>
            <button type="button"
              className="group flex flex-col gap-0.5 mx-1.5 px-2.5 py-1.5 rounded w-[calc(100%-12px)] text-left cursor-pointer bg-transparent hover:!bg-[var(--accent)] border-none"
              onClick={() => handleCreate('fixed')}>
              <div className="text-xs font-medium text-[var(--text-primary)] group-hover:text-[var(--accent-fg)]">Modal</div>
              <div className="text-[11px] text-[var(--text-secondary)] group-hover:text-[var(--accent-fg)]/80">Full-screen overlay with backdrop</div>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Appear Enter/Exit transition (baked into the Overlay tool) ──────────────
const DEFAULT_ENTER_TRANSITION: Record<string, string> = { type: 'tween', duration: '0.3', ease: 'easeIn' };
const DEFAULT_EXIT_TRANSITION: Record<string, string> = { type: 'tween', duration: '0.3', ease: 'easeOut' };

/** Enter + Exit appear TRANSITION rows. Each opens the SAME Motion transition
 *  editor (`TransitionPanel`: Instant/Ease/Spring + bezier curve + time/delay)
 *  in a ToolPopup, with the exact swatch (curve icon + summary) + lock from the
 *  Appear popup. Locked → Exit transition stays identical to Enter. Writes the
 *  overlay's BASE config enterTransition/exitTransition/easingLinked. */
function OverlayAppearRows({ overlayId, overlayConfig }: { overlayId: string; overlayConfig: OverlayConfig }) {
  const enter = overlayConfig.enterTransition ?? DEFAULT_ENTER_TRANSITION;
  const exit = overlayConfig.exitTransition ?? DEFAULT_EXIT_TRANSITION;
  const linked = overlayConfig.easingLinked !== false; // default linked
  const enterRef = useRef<HTMLDivElement>(null);
  const exitRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<null | 'enter' | 'exit'>(null);
  const write = useCallback((patch: Partial<OverlayConfig>) => {
    queueMutation({ type: 'updateOverlayConfig', overlayId, patch, vpWidth: null });
    flushNow();
    trace.action('overlay-tool:update-transition', { overlayId, keys: Object.keys(patch) });
  }, [overlayId]);
  // Locked → Enter and Exit are the SAME transition; editing either updates both.
  const setEnter = (t: Record<string, string>) => write(linked ? { enterTransition: t, exitTransition: t } : { enterTransition: t });
  const setExit = (t: Record<string, string>) => write(linked ? { exitTransition: t, enterTransition: t } : { exitTransition: t });
  const toggleLink = () => write({ easingLinked: !linked });
  const stroke = linked ? 'var(--accent)' : 'var(--text-secondary)';

  return (
    <div className="flex flex-col gap-2">
      {/* Enter — curve-icon swatch + transition summary (exact Appear-popup affordance) */}
      <div ref={enterRef} className="flex items-center justify-between w-full">
        <ControlLabel label="Enter" property="" plain />
        <ControlActionRow onClick={() => setOpen('enter')}>
          <TransitionCurveIcon isSpring={enter.type === 'spring'} />
          <span className="text-[var(--text-secondary)] truncate">{summarizeTransition(enter)}</span>
        </ControlActionRow>
      </div>

      {/* Enter↔Exit lock — EXACT bracket + padlock from OverlayAppearPopup (0-height
          row; absolutely-positioned lock + connector curves bridging the gap). */}
      <div className="relative" style={{ height: 0, marginTop: '-0.25rem', marginBottom: '-0.25rem' }}>
        <div className="absolute flex items-center justify-center" style={{ left: '35%', top: -10, transform: 'translateX(-50%)' }}>
          <svg className="absolute pointer-events-none" style={{ left: 1, top: -38, width: 10, height: 40, overflow: 'visible' }}>
            <path d="M 0,37 Q 0,31 6,29 L 11,29" fill="none" stroke={stroke} strokeWidth="1" />
          </svg>
          <button
            type="button"
            onClick={toggleLink}
            className={`p-0.5 hover:bg-[var(--bg-hover)] rounded transition-colors absolute z-10 pointer-events-auto cursor-pointer ${linked ? 'text-[var(--accent-text)]' : 'text-[var(--text-secondary)]'}`}
            style={{ left: -7, top: 2 }}
            title={linked ? 'Exit linked to Enter — unlink to edit separately' : 'Exit unlinked — link to match Enter'}
          >
            {linked ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 9.9-1" />
              </svg>
            )}
          </button>
          <svg className="absolute pointer-events-none" style={{ left: 1, top: 19, width: 10, height: 40, overflow: 'visible' }}>
            <path d="M 0,3 Q 0,8 6,11 L 11,11" fill="none" stroke={stroke} strokeWidth="1" />
          </svg>
        </div>
      </div>

      {/* Exit */}
      <div ref={exitRef} className="flex items-center justify-between w-full">
        <ControlLabel label="Exit" property="" plain />
        <ControlActionRow onClick={() => setOpen('exit')}>
          <TransitionCurveIcon isSpring={exit.type === 'spring'} />
          <span className="text-[var(--text-secondary)] truncate">{summarizeTransition(exit)}</span>
        </ControlActionRow>
      </div>

      <ToolPopup isOpen={open === 'enter'} onClose={() => setOpen(null)} title="Enter" anchorRef={enterRef} width={280}>
        <TransitionPanel initialTransition={enter} onWrite={setEnter} />
      </ToolPopup>
      <ToolPopup isOpen={open === 'exit'} onClose={() => setOpen(null)} title="Exit" anchorRef={exitRef} width={280}>
        <TransitionPanel initialTransition={exit} onWrite={setExit} />
      </ToolPopup>
    </div>
  );
}

// ─── Overlay Controls ────────────────────────────────────────────────────────
// standard rows: Position (select) / Align (icon segmented) / Offset (X+Y)
// / Dismiss (Auto|Click) / Collision (Auto|None + padding px).

function OverlayControls({ nodeId, overlayConfig, allTriggers }: {
  nodeId: string;
  overlayConfig: OverlayConfig;
  allTriggers: OverlayTriggerCall[];
}) {
  // Viewport-aware editing: on the PRIMARY viewport we write the base config;
  // on a REPLICA we write a per-breakpoint override (`config.responsive[width]`)
  // and show a blue reset dot on each overridden row — same model as the
  // responsive style system. Displayed values are the RESOLVED config for the
  // current viewport.
  const interactingVpId = useAtomValue(interactingViewportIdAtom);
  const vpWidths = useAtomValue(viewportWidthsAtom);
  const isComponentFile = useAtomValue(isComponentFileAtom);
  const isPrimary = isPrimaryViewport(interactingVpId);
  const vpWidth = vpWidths[interactingVpId] ?? 0;
  // In a design component a non-primary VARIANT is the replica analog of a
  // page's non-primary viewport — its override is keyed by the variant NAME
  // (`interactingVpId`), not a width. `variantKey` is set only for a non-primary
  // component variant; everything else stays on the width path.
  const variantKey = isComponentFile && !isPrimary ? interactingVpId : null;
  const effective = isPrimary ? overlayConfig : resolveOverlayConfig(overlayConfig, interactingVpId, vpWidth);
  const override: OverlayConfigOverride = isPrimary ? {}
    : variantKey ? (overlayConfig.responsiveVariant?.[variantKey] || {})
    : (overlayConfig.responsive?.[String(vpWidth)] || {});

  const breakpoints = Object.values(vpWidths);
  const updatePosition = useCallback((patch: OverlayConfigOverride) => {
    queueMutation({ type: 'updateOverlayConfig', overlayId: nodeId, patch,
      vpWidth: variantKey ? null : (isPrimary ? null : vpWidth), breakpoints, variant: variantKey });
    trace.action('overlay-tool:update-config', { nodeId, vpWidth: isPrimary ? null : vpWidth, variant: variantKey, ...patch });
  }, [nodeId, isPrimary, vpWidth, breakpoints, variantKey]);

  const resetOverride = useCallback((keys: (keyof OverlayConfigOverride)[]) => {
    queueMutation({ type: 'updateOverlayConfig', overlayId: nodeId, patch: {},
      vpWidth: variantKey ? null : vpWidth, resetKeys: keys, breakpoints, variant: variantKey });
    trace.action('overlay-tool:reset-override', { nodeId, vpWidth, variant: variantKey, keys });
  }, [nodeId, vpWidth, breakpoints, variantKey]);

  // Is a given set of config keys overridden for the CURRENT (replica) viewport?
  // Drives the accent color + reset dot on the row's ControlLabel.
  const isOverridden = (keys: (keyof OverlayConfigOverride)[]) =>
    !isPrimary && keys.some(k => override[k] !== undefined);

  // Modal-level fields (fill/dismissible/zIndex/pageScroll) are NOT per-viewport —
  // always written to the BASE config (vpWidth null, no variant).
  const updateBase = useCallback((patch: Partial<OverlayConfig>) => {
    queueMutation({ type: 'updateOverlayConfig', overlayId: nodeId, patch, vpWidth: null, breakpoints });
    flushNow();
    trace.action('overlay-tool:update-base', { nodeId, ...patch });
  }, [nodeId, breakpoints]);
  const resetBase = useCallback((keys: ('fill' | 'dismissible' | 'zIndex' | 'pageScroll')[]) => {
    queueMutation({ type: 'updateOverlayConfig', overlayId: nodeId, patch: {}, vpWidth: null, resetKeys: keys, breakpoints });
    flushNow();
    trace.action('overlay-tool:reset-base', { nodeId, keys });
  }, [nodeId, breakpoints]);

  // Live (per-frame) backdrop-fill preview during a color-picker drag. The
  // Renderer paints the scrim as the overlay element's inline `backgroundColor`
  // (Renderer.ts: `el.style.backgroundColor = config.fill`), so a bridge
  // `patchStyles` writes the exact same property with NO mutation-queue /
  // flushNow re-render — the killer of the previous per-frame path. Fill is a
  // BASE (all-viewport) property and overlay-edit mode shows every viewport's
  // copy, so paint each visible copy (a missing copy is a harmless no-op). The
  // source write lands once on release via `updateBase`.
  const updateFillLive = useCallback((c: string) => {
    const bridge = getCanvasBridge();
    const prefixes = new Set<string>(['', getViewportPrefix(interactingVpId)]);
    for (const vpId of Object.keys(vpWidths)) prefixes.add(getViewportPrefix(vpId));
    for (const p of prefixes) bridge.patchStyles(nodeId, p, { backgroundColor: c });
    trace.action('overlay-tool:fill-live', { nodeId, fill: c });
  }, [nodeId, interactingVpId, vpWidths]);

  // Dismiss lives on the TRIGGER config (it gates the trigger's handlers) but
  // surfaces here so the whole overlay setup is editable from one panel.
  const triggerInfo = getTriggerForNode(allTriggers, overlayConfig.triggerId);
  const updateDismiss = useCallback((v: string) => {
    if (!triggerInfo) return;
    queueMutation({ type: 'updateOverlayTrigger', triggerId: overlayConfig.triggerId,
      config: { ...triggerInfo.config, dismiss: v as 'outside' | 'click' } });
    trace.action('overlay-tool:update-dismiss', { overlayId: nodeId, dismiss: v });
  }, [triggerInfo, overlayConfig.triggerId, nodeId]);

  if (overlayConfig.type === 'fixed') {
    // Modal: backdrop FILL, DISMISSIBLE (backdrop-press closes), Enter/Exit
    // appear easing (baked-in, see OverlayAppearRows), Z INDEX, PAGE SCROLL.
    // No Position/Align/Offset/Collision — a fixed modal covers the viewport.
    const fill = overlayConfig.fill ?? DEFAULT_FIXED_FILL;
    const dismissible = overlayConfig.dismissible !== false; // default true
    const zIndex = overlayConfig.zIndex ?? 100;
    const pageScroll = overlayConfig.pageScroll ?? 'block';
    return (
      <div className="flex flex-col gap-2">
        {/* Fill — backdrop scrim color (with alpha) */}
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Fill" property="" plain />
          <div className="w-full">
            <ColorInput
              value={fill}
              onChange={(c) => updateBase({ fill: c })}
              onChangeLive={updateFillLive}
              showAlpha
              onRemove={overlayConfig.fill !== undefined ? () => resetBase(['fill']) : undefined}
            />
          </div>
        </div>

        {/* Dismissible — does pressing the backdrop close the modal */}
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Dismissible" property="" plain />
          <div className="w-full">
            <ToolSegmentedControl
              value={dismissible ? 'yes' : 'no'}
              onChange={(v) => updateBase({ dismissible: v === 'yes' })}
              options={DISMISSIBLE_OPTIONS}
              size="sm"
            />
          </div>
        </div>

        {/* Enter / Exit appear easing (baked-in, lock-linked) */}
        <OverlayAppearRows overlayId={nodeId} overlayConfig={overlayConfig} />

        {/* Z Index — modal stacking order */}
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Z Index" property="" plain />
          <div className="w-full">
            <ToolInput
              value={String(zIndex)}
              onChange={(v) => updateBase({ zIndex: Math.round(parseFloat(v) || 0) })}
              step={1}
            />
          </div>
        </div>

        {/* Page Scroll — lock body scroll behind the modal, or leave it */}
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Page Scroll" property="" plain />
          <div className="w-full">
            <ToolSegmentedControl
              value={pageScroll}
              onChange={(v) => updateBase({ pageScroll: v as 'auto' | 'block' })}
              options={PAGE_SCROLL_OPTIONS}
              size="sm"
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Position — which side of the trigger the overlay attaches to */}
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Position" property="overlay-side"
          hideResetStyle hideCreateVariable hideCmsBinding
          overridden={isOverridden(['side'])} onResetOverride={() => resetOverride(['side'])} />
        <div className="w-full">
          <ToolSelect
            value={effective.side}
            onChange={(v) => updatePosition({ side: v as OverlayConfig['side'] })}
            options={POSITION_OPTIONS}
          />
        </div>
      </div>

      {/* Align — start / center / end along the attached side */}
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Align" property="overlay-align"
          hideResetStyle hideCreateVariable hideCmsBinding
          overridden={isOverridden(['align'])} onResetOverride={() => resetOverride(['align'])} />
        <div className="w-full">
          <ToolSegmentedControl
            value={effective.align}
            onChange={(v) => updatePosition({ align: v as OverlayConfig['align'] })}
            options={ALIGN_OPTIONS}
            size="sm"
          />
        </div>
      </div>

      {/* Offset — X / Y nudge from the computed position */}
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Offset" property="overlay-offset"
          hideResetStyle hideCreateVariable hideCmsBinding
          overridden={isOverridden(['offsetX', 'offsetY'])} onResetOverride={() => resetOverride(['offsetX', 'offsetY'])} />
        <div className="flex items-center gap-2 w-full">
          <ToolInput value={String(effective.offsetX ?? 0)} step={1} chevronLabel="X"
            onChange={(v) => updatePosition({ offsetX: parseFloat(v) || 0 })} />
          <ToolInput value={String(effective.offsetY ?? 0)} step={1} chevronLabel="Y"
            onChange={(v) => updatePosition({ offsetY: parseFloat(v) || 0 })} />
        </div>
      </div>

      {/* Dismiss — Auto (click outside / Escape) vs Click (trigger only). Shared
          across viewports (lives on the trigger config), so no override dot. */}
      {triggerInfo && (
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Dismiss" property="" plain />
          <div className="w-full">
            <ToolSegmentedControl
              value={triggerInfo.config.dismiss === 'click' ? 'click' : 'outside'}
              onChange={updateDismiss}
              options={DISMISS_OPTIONS}
              size="sm"
            />
          </div>
        </div>
      )}

      {/* Collision — keep the overlay inside the viewport with padding */}
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Collision" property="overlay-collision"
          hideResetStyle hideCreateVariable hideCmsBinding
          overridden={isOverridden(['collision', 'collisionPadding'])} onResetOverride={() => resetOverride(['collision', 'collisionPadding'])} />
        <div className="flex items-center gap-2 w-full">
          <ToolSelect
            value={effective.collision ?? 'auto'}
            onChange={(v) => updatePosition({ collision: v as 'auto' | 'none' })}
            options={COLLISION_OPTIONS}
          />
          <ToolInput value={String(effective.collisionPadding ?? 20)} step={1} chevronLabel="PX"
            disabled={(effective.collision ?? 'auto') === 'none'}
            onChange={(v) => updatePosition({ collisionPadding: Math.max(0, parseFloat(v) || 0) })} />
        </div>
      </div>
    </div>
  );
}
