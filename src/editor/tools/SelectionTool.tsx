// SelectionTool.tsx — Multi-select properties panel.
//
// Aggregates background fills (solid colors + gradients) across every
// selected node, de-duplicates by exact value, and renders one row per
// unique value. Editing a row propagates the new value to every selected
// node that had the old one — so the user can recolor matching elements
// as a group without touching each one individually.
//
// COLLAPSED state (compact): one "Colors" row with inline swatch
//   previews — up to 4 inline; overflow becomes `+N`.
// EXPANDED state: full list with one SelectionFillRow per unique value
//   so each is editable. Header carries a `+` / `-` toggle.
//
// Each fill row opens a popup with Color / Gradient tabs (same shape as
// FillControl's Single mode, minus Image / Video — those don't make
// sense across heterogeneous nodes). Switching tabs clears the other
// fill type's property so the rendered background matches the active
// tab.

import { useRef, useState, useEffect } from 'react';
import { useLivePreview } from '../hooks/useLivePreview';
import { useAtomValue } from 'jotai';
import { selectedIdsAtom, getNodeFromCache } from '@/code/stores/store';
import { useNodesComputed } from '@/code/stores/node-family';
import { ColorSwatch, ToolSegmentedControl, ControlActionRow } from '../controls';
import ToolPopup from '../ui/ToolPopup';
import ColorPicker from '../ui/ColorPicker';
import GradientEditor from '../ui/GradientEditor';
import { presetTokensAtom } from '@/code/stores/preset-store';
import { toHexDisplay } from '../ui/color-utils';
import { updateNodeStyles, getContentRoot, parseRectCacheKey } from '@/canvas/node-ops';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { trace } from '@/shared/debug-trace';
import { parseVarRef } from '@/shared/css-utils';

/** Skip these as "no fill" so the aggregation isn't dominated by transparent
 *  defaults the user didn't intentionally set. */
const EMPTY_VALUES = new Set(['', 'transparent', 'rgba(0, 0, 0, 0)', 'rgba(0,0,0,0)', 'none']);

/** Threshold for inline display in the collapsed row. ≤ this many unique
 *  fills → render every swatch; more than this → render the first 4 and
 *  add `+N`. */
const INLINE_LIMIT = 4;

interface ColorGroup {
  /** The exact CSS value the rule applies to. */
  value: string;
  /** Node ids that currently render with this value. */
  nodeIds: string[];
  /** Whether the value is a gradient (vs. a plain color). */
  isGradient: boolean;
}

function isGradientValue(v: string): boolean {
  return /\b(linear-gradient|radial-gradient|conic-gradient|repeating-)/.test(v);
}

/** Group selected nodes by their background fill. Reads both
 *  `backgroundColor` (solid colors) AND `background` / `backgroundImage`
 *  (gradients) so the aggregator picks up every authored fill. */
function aggregateFills(
  selectedIds: string[],
  nodes: Map<string, import('@/code/parsing/parser').CanvasNode>,
): ColorGroup[] {
  const map = new Map<string, { ids: string[]; isGradient: boolean }>();
  const collect = (id: string, raw: string | undefined) => {
    if (!raw || EMPTY_VALUES.has(raw)) return;
    const existing = map.get(raw);
    if (existing) existing.ids.push(id);
    else map.set(raw, { ids: [id], isGradient: isGradientValue(raw) });
  };
  for (const id of selectedIds) {
    const n = getNodeFromCache(id) ?? nodes.get(id);
    if (!n) continue;
    collect(id, n.styles?.backgroundColor);
    const bg = n.styles?.background;
    if (bg && isGradientValue(bg)) collect(id, bg);
    const bgImg = n.styles?.backgroundImage;
    if (bgImg && isGradientValue(bgImg)) collect(id, bgImg);
  }
  return Array.from(map.entries())
    .map(([value, { ids, isGradient }]) => ({ value, nodeIds: ids, isGradient }))
    .sort((a, b) => b.nodeIds.length - a.nodeIds.length || a.value.localeCompare(b.value));
}

/** Fan-out helper — write the same styles map to every id in `ids` via
 *  the standard `updateNodeStyles` path (so per-node replica/variant
 *  routing keeps working). */
function writeStylesToNodes(ids: string[], styles: Record<string, string>): void {
  const contentEl = getContentRoot();
  if (!contentEl) return;
  for (const id of ids) {
    updateNodeStyles({ id, styles, contentEl });
  }
}

/** LIVE preview — imperative DOM patch only, NO code write. Same `bridge.patchStyles`
 *  fan-out as ControlProvider.updateStyleLive's primary path, but scoped to a specific
 *  group of node ids. Called on every drag frame so multi-select fill/gradient stays
 *  60fps; the code commit (`writeStylesToNodes`) runs ONCE on pointer release. Without
 *  this, the picker's per-frame onChange went straight to `updateNodeStyles` → a queued
 *  mutation → a full page re-parse PER FRAME — exactly the multi-select drag lag. */
function livePatchToNodes(ids: string[], styles: Record<string, string>): void {
  const bridge = getCanvasBridge();
  // Patch the primary tile + every replica viewport prefix the bridge knows about
  // (a multi-select fill is a primary/base edit, so it cascades to all tiles).
  const rectCache = (bridge as any).rectCache as Map<string, DOMRect> | undefined;
  const prefixes = new Set<string>(['']);
  if (rectCache) {
    for (const cacheKey of rectCache.keys()) {
      const parsed = parseRectCacheKey(cacheKey);
      if (!parsed) continue;
      prefixes.add(parsed.vpPrefix);
    }
  }
  for (const id of ids) {
    for (const prefix of prefixes) bridge.patchStyles(id, prefix, styles);
  }
}

// ─── SelectionFillRow ────────────────────────────────────────────────────────
//
// One row per unique fill across the multi-select. Renders a clickable pill
// (swatch + value) and opens a tabbed popup (Color / Gradient) on click. Tab
// content uses the same ColorPicker / GradientEditor as the Fill control —
// edits route through `writeStylesToNodes` so the change fans out to every
// node currently sharing this fill.

type FillTab = 'color' | 'gradient';

function SelectionFillRow({ group, nodeIds }: {
  group: ColorGroup;
  /** Captured at render time so the writer doesn't depend on `group`
   *  re-aggregating mid-edit. */
  nodeIds: string[];
}) {
  const btnRef = useRef<HTMLSpanElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [tab, setTab] = useState<FillTab>(group.isGradient ? 'gradient' : 'color');
  const allTokens = useAtomValue(presetTokensAtom);
  const colorPresets = allTokens.filter(t => t.category === 'color');

  // Keep the active tab in sync when the group's type flips (e.g. user
  // switches from color → gradient via tab + commits). Without this the
  // popup would re-open on the wrong tab next time.
  useEffect(() => {
    setTab(group.isGradient ? 'gradient' : 'color');
  }, [group.isGradient]);

  // Live swatch sync: during a drag the canvas patches imperatively (no code
  // commit), so `group.value` — parsed from the committed source — stays stale until
  // release. Mirror the single-node Fill's `livePreviewColor`: the picker's live
  // callbacks set this, and the swatch/label read it so the panel tracks the drag in
  // real time. Cleared whenever the committed value lands (group.value changes on the
  // next re-parse), exactly like FillControl resets on styles.backgroundColor.
  const [livePreview, setLivePreview] = useLivePreview<string>([group.value]);

  const displayValue = livePreview ?? group.value;
  const showAsGradient = livePreview != null ? tab === 'gradient' : group.isGradient;
  const swatchStyle = { background: displayValue };
  const labelText = showAsGradient ? 'Gradient' : toHexDisplay(displayValue);

  // Tab switch is UI-only. Clearing the old fill type here used to
  // wipe the row's underlying value mid-switch, the aggregator
  // emitted an empty list, the row unmounted, and the popup flickered
  // and disappeared — the user saw "tab switch glitches and gradient
  // can't be applied". Instead, defer the clear until the user
  // actually commits a value in the NEW tab (see the picker / editor
  // onChange handlers below — each one writes its own property AND
  // clears the opposite type in the same `updateNodeStyles` call, so
  // the swap is atomic and the row stays mounted across it).
  const handleTabChange = (newTab: FillTab) => {
    if (newTab === tab) return;
    trace.action('selection-fill:tab-change', { from: tab, to: newTab, count: nodeIds.length });
    setTab(newTab);
  };

  return (
    <>
      <span ref={btnRef} className="contents">
        <ControlActionRow onClick={() => setIsOpen(true)} className="justify-between">
          <span className="flex items-center gap-2 truncate">
            <ColorSwatch style={swatchStyle} />
            <span className="text-xs truncate text-[var(--text-primary)]">{labelText}</span>
          </span>
        </ControlActionRow>
      </span>

      <ToolPopup
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        title={tab === 'color' ? 'Color' : 'Gradient'}
        anchorRef={btnRef}
        width={280}
      >
        <ToolSegmentedControl
          value={tab}
          onChange={(v) => handleTabChange(v as FillTab)}
          options={[
            { value: 'color', label: 'Color' },
            { value: 'gradient', label: 'Gradient' },
          ]}
          size="sm"
        />

        {tab === 'color' && (() => {
          // Resolve preset references through the token map so the picker
          // opens on the actual color, not the var() reference.
          const presetName = group.value.startsWith('var(--')
            ? parseVarRef(group.value) || ''
            : '';
          const resolved = presetName
            ? (colorPresets.find(t => t.name === presetName)?.value || '#000000')
            : (group.isGradient ? '#000000' : group.value || '#000000');
          return (
            <ColorPicker
              value={resolved}
              onChange={(c) => {
                // LIVE: imperative DOM patch every drag frame, NO code write — 60fps,
                // and sync this row's panel swatch/label to the dragged color.
                livePatchToNodes(nodeIds, { backgroundColor: c, background: '', backgroundImage: '' });
                setLivePreview(c);
              }}
              onChangeEnd={(c) => {
                // COMMIT once on pointer release. Atomic swap: set color, clear gradient
                // in a single updateStyles call so the aggregator sees the new value WITH
                // the old gradient already gone (no empty-group intermediate that would
                // unmount the row).
                writeStylesToNodes(nodeIds, { backgroundColor: c, background: '', backgroundImage: '' });
              }}
              showAlpha
              colorPresets={colorPresets}
              onApplyPreset={(varVal) => writeStylesToNodes(nodeIds, {
                backgroundColor: varVal,
                background: '',
                backgroundImage: '',
              })}
              activePresetName={presetName || undefined}
            />
          );
        })()}

        {tab === 'gradient' && (
          <GradientEditor
            value={group.isGradient ? group.value : ''}
            onChange={(css) => {
              // COMMIT on release — GradientEditor fires onChange once on pointer-up
              // now that onLiveChange is supplied (without it, onChange fell back to
              // firing per-frame → a code commit every frame, the gradient drag lag).
              // Atomic swap: gradient on `backgroundImage`, clear `background` shorthand
              // + `backgroundColor` in one write so the aggregator never sees an empty
              // intermediate state.
              writeStylesToNodes(nodeIds, {
                backgroundImage: css,
                background: '',
                backgroundColor: '',
              });
            }}
            onLiveChange={(css) => {
              // LIVE every drag frame — imperative DOM patch only, no code write (60fps),
              // and sync this row's panel swatch to the dragged gradient.
              livePatchToNodes(nodeIds, { backgroundImage: css, background: '', backgroundColor: '' });
              setLivePreview(css);
            }}
            hideOverlay
          />
        )}
      </ToolPopup>
    </>
  );
}

export default function SelectionTool() {
  const selectedIds = useAtomValue(selectedIdsAtom);
  const [isExpanded, setIsExpanded] = useState(false);

  const groups = useNodesComputed(
    (nodes) => aggregateFills(selectedIds, nodes),
    [selectedIds],
  );

  if (selectedIds.length <= 1) return null;
  if (groups.length === 0) return null;

  const compactGroups = groups.slice(0, INLINE_LIMIT);
  const overflow = groups.length - compactGroups.length;

  return (
    <div className="px-2">
      {/* Header — title + toggle icon. Title click toggles too. */}
      <div className="mb-1.5 flex items-center justify-between py-1.5">
        <span
          onClick={() => setIsExpanded(v => !v)}
          className="text-xs font-bold text-[var(--text-primary)] cursor-pointer select-none"
        >
          Selection
        </span>
        <button
          onClick={() => setIsExpanded(v => !v)}
          className="flex items-center justify-center cursor-pointer text-[var(--text-primary)] hover:opacity-80 transition-opacity"
          title={isExpanded ? 'Collapse' : 'Expand'}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="5" y1="12" x2="19" y2="12" />
            {!isExpanded && <line x1="12" y1="5" x2="12" y2="19" />}
          </svg>
        </button>
      </div>

      <div className="flex flex-col py-0.5 gap-2 pl-3">
        <div className="flex items-start justify-between w-full">
          {/* Label flex-child carries the chevron-gutter geometry DIRECTLY
              (`w-3/4 pl-[18px] -ml-[18px]`) so its flex footprint matches the
              Styles rows (Fill/Radius/Margin) — whose labels are the NON-plain
              `<button>` ControlLabel (ControlLabel.tsx:729), ALSO
              `w-3/4 pl-[18px] -ml-[18px]` with NO `mr-[2px]`. The `mr-[2px]`
              shim lives ONLY on the plain `<span>` variant (ControlLabel:189)
              because an inline `<span>` measures 2px narrower than a
              `<button>`; a block `<div>` measures like the button, so adding
              `mr-[2px]` here made the label 2px too WIDE → colors 2px short.
              (It was ALSO double-wrapped before — an outer `w-3/4` div around a
              plain ControlLabel that ALSO renders `w-3/4` → ~16px short.)
              `h-8 items-center` centers the single-line label with the first
              32-px color row. */}
          <div className="h-8 flex items-center w-3/4 min-w-0 pl-[18px] -ml-[18px]">
            <span className="text-xs font-bold text-[var(--text-secondary)] select-none truncate" title="Colors">
              Colors
            </span>
          </div>
          <div className="flex flex-col gap-1.5 w-full">
            {isExpanded ? (
              groups.map(group => (
                // KEY by `nodeIds[0]`: live edits change `group.value`,
                // and a value-keyed component would unmount mid-drag and
                // close the popup. The node id set is stable across
                // value edits.
                <SelectionFillRow
                  key={group.nodeIds[0]}
                  group={group}
                  nodeIds={group.nodeIds}
                />
              ))
            ) : (
              <button
                onClick={() => setIsExpanded(true)}
                className="w-full h-[var(--control-height)] flex items-center gap-1.5 px-2 bg-[var(--grid-line)] border border-[var(--control-border)] cut-corners cut-border hover:[--cut-border-color:var(--control-border-hover)] hover:border-[var(--control-border-hover)] transition-colors cursor-pointer"
                title="Click to expand"
              >
                {compactGroups.map(g => (
                  <ColorSwatch key={g.value} style={{ background: g.value }} size="sm" />
                ))}
                {overflow > 0 && (
                  <span className="text-[10px] text-[var(--text-disabled)] ml-auto">+{overflow}</span>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
