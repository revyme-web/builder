// ShadowControl.tsx — Fully self-contained shadow ToolAtom.
// Multi-entry box-shadow + drop-shadow editor using unified control system.

import { useState, useRef, useEffect, useCallback } from 'react';
import { useDebouncedCallback } from '@/editor/hooks/useDebouncedCallback';
import { useAtomValue, useSetAtom } from 'jotai';
import { projectVersionAtom } from '@/code/project/project-fs';
import { liveUpdatePresetToken } from '../../../ui/preset-live-update';
import { UnifiedControlProvider } from '../../../controls/unified/ControlProvider';
import { useControlContext, ShowControlLabels } from '../../../controls/unified/useControlContext';
import { UsedByRow } from '../../../controls/unified/UsedByRow';
import type { AtomProps } from '../../../controls/unified/types';
import ToolInput from '../../../controls/ToolInput';
import ToolSegmentedControl from '../../../controls/ToolSegmentedControl';
import ToolPlusMinus from '../../../controls/ToolPlusMinus';
import ColorInput from '../../../controls/ColorInput';
import { EntryList } from '../../../controls/EntryList';
import ControlLabel from '../../../controls/ControlLabel';
import { ColorSwatch } from '../../../controls/ColorSwatch';
import { useHoistMenuItem } from '../../../controls/hoist-context';
import { VariableBoundPill } from '../../../controls/VariableBoundPill';
import { ShadowIcon } from '@/design-system/PropertyIcons';
import ToolPopup from '../../../ui/ToolPopup';
import { useEditorPanel } from '../../../hooks/useEditorPanel';
import {
  parseShadowEntries, formatShadowEntries, mergeFilterWithDropShadows,
  shadowSummary, createDefaultShadow,
  type ShadowEntry,
} from '../../../ui/shadow-utils';
import { parsePx, formatPx } from '../style-helpers';
import { presetTokensAtom } from '@/code/stores/preset-store';
import { trace } from '@/shared/debug-trace';
import { resolvePresetColor } from '@/shared/css-utils';

// ─── Self-contained editor panel (reactive inside pushPanel) ─────────────────

function ShadowEditorPanel({ initialIdx, initialBoxShadow, initialFilter, onChangeLive, onCommit }: {
  initialIdx: number;
  initialBoxShadow: string;
  initialFilter: string;
  /** Multi-prop DOM-only live patch (boxShadow + filter) — chevron-drag. */
  onChangeLive: (styles: Record<string, string>) => void;
  onCommit: (styles: Record<string, string>) => void;
}) {
  const boxShadow = initialBoxShadow;
  const filter = initialFilter;

  const [entries, setEntries] = useState<ShadowEntry[]>(() => parseShadowEntries(boxShadow, filter));
  const [activeIdx, setActiveIdx] = useState(initialIdx);
  const selfWriteCountRef = useRef(0);
  const prevBoxRef = useRef(boxShadow);
  const prevFilterRef = useRef(filter);

  // The popup stays mounted across entry switches (single ToolPopup, not a remount). `useState(initialIdx)` only
  // seeds on MOUNT — so clicking a DIFFERENT shadow row while the popup is open re-passes a new `initialIdx` but
  // left the panel showing the first shadow. Sync to it so the popup follows the row you click.
  useEffect(() => { setActiveIdx(initialIdx); }, [initialIdx]);

  useEffect(() => {
    if (boxShadow !== prevBoxRef.current || filter !== prevFilterRef.current) {
      prevBoxRef.current = boxShadow;
      prevFilterRef.current = filter;
      if (selfWriteCountRef.current > 0) {
        selfWriteCountRef.current--;
        return;
      }
      const parsed = parseShadowEntries(boxShadow, filter);
      setEntries(parsed);
      if (activeIdx >= parsed.length) setActiveIdx(Math.max(0, parsed.length - 1));
    }
  }, [boxShadow, filter]);

  const commitEntries = (newEntries: ShadowEntry[]) => {
    const withIds = newEntries.map((e, i) => ({ ...e, id: `shadow-${i}` }));
    setEntries(withIds);
    const { boxShadow: newBoxShadow, dropShadowFilter } = formatShadowEntries(withIds);
    trace.action('shadow-panel:commit', { count: withIds.length });
    selfWriteCountRef.current = 2;
    const merged = mergeFilterWithDropShadows(filter, dropShadowFilter);
    onCommit({ boxShadow: newBoxShadow, filter: merged });
  };

  const updateEntry = (idx: number, patch: Partial<ShadowEntry>) => {
    const updated = entries.map((e, i) => i === idx ? { ...e, ...patch } : e);
    commitEntries(updated);
  };

  // LIVE — every chevron-drag frame: local state + DOM-only patch of BOTH
  // boxShadow + filter. NO code write, NO selfWriteCount bump (a DOM patch
  // doesn't echo back through `value`). The commit fires on chevron release.
  const liveEntries = (newEntries: ShadowEntry[]) => {
    const withIds = newEntries.map((e, i) => ({ ...e, id: `shadow-${i}` }));
    setEntries(withIds);
    const { boxShadow: newBoxShadow, dropShadowFilter } = formatShadowEntries(withIds);
    const merged = mergeFilterWithDropShadows(filter, dropShadowFilter);
    onChangeLive({ boxShadow: newBoxShadow, filter: merged });
  };
  const updateEntryLive = (idx: number, patch: Partial<ShadowEntry>) => {
    liveEntries(entries.map((e, i) => i === idx ? { ...e, ...patch } : e));
  };

  const activeEntry = entries[activeIdx];
  if (!activeEntry) return null;

  // Force the per-field labels visible: when this popup opens from the Variable modal's Default row the
  // atom carries `hideLabel`, but inside the expanded editor X / Y / Blur / Spread / Color MUST be labelled.
  return (
    <ShowControlLabels>
    <div className="flex flex-col gap-2">
      <ToolSegmentedControl
        value={activeEntry.type}
        onChange={(v) => {
          const patch: Partial<ShadowEntry> = { type: v as 'box' | 'drop' };
          if (v === 'drop') { patch.spread = 0; patch.inset = false; }
          updateEntry(activeIdx, patch);
        }}
        options={[{ value: 'box', label: 'Box' }, { value: 'drop', label: 'Drop' }]}
        size="sm"
      />
      {activeEntry.type === 'box' && (
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Position" property="boxShadow" plain />
          <div className="w-full">
            <ToolSegmentedControl
              value={activeEntry.inset ? 'inside' : 'outside'}
              onChange={(v) => updateEntry(activeIdx, { inset: v === 'inside' })}
              options={[{ value: 'outside', label: 'Outside' }, { value: 'inside', label: 'Inside' }]}
              size="sm"
            />
          </div>
        </div>
      )}
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Color" property="boxShadow" plain />
        <div className="flex items-center gap-2 w-full">
          <ColorInput value={activeEntry.color} onChange={(v) => updateEntry(activeIdx, { color: v })} onChangeLive={(v) => updateEntryLive(activeIdx, { color: v })} showAlpha />
        </div>
      </div>
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="X" property="boxShadow" plain />
        <div className="flex items-center gap-2 w-full">
          <ToolInput value={formatPx(activeEntry.x)} onChange={(v) => updateEntry(activeIdx, { x: parsePx(v) })} onChangeLive={(v) => updateEntryLive(activeIdx, { x: parsePx(v) })} onCommit={(v) => updateEntry(activeIdx, { x: parsePx(v) })} step={1} />
          <ToolPlusMinus value={activeEntry.x} onChange={(v) => updateEntry(activeIdx, { x: v })} min={-100} max={100} />
        </div>
      </div>
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Y" property="boxShadow" plain />
        <div className="flex items-center gap-2 w-full">
          <ToolInput value={formatPx(activeEntry.y)} onChange={(v) => updateEntry(activeIdx, { y: parsePx(v) })} onChangeLive={(v) => updateEntryLive(activeIdx, { y: parsePx(v) })} onCommit={(v) => updateEntry(activeIdx, { y: parsePx(v) })} step={1} />
          <ToolPlusMinus value={activeEntry.y} onChange={(v) => updateEntry(activeIdx, { y: v })} min={-100} max={100} />
        </div>
      </div>
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Blur" property="boxShadow" plain />
        <div className="flex items-center gap-2 w-full">
          <ToolInput value={formatPx(activeEntry.blur)} onChange={(v) => updateEntry(activeIdx, { blur: parsePx(v) })} onChangeLive={(v) => updateEntryLive(activeIdx, { blur: parsePx(v) })} onCommit={(v) => updateEntry(activeIdx, { blur: parsePx(v) })} step={1} />
          <ToolPlusMinus value={activeEntry.blur} onChange={(v) => updateEntry(activeIdx, { blur: v })} min={0} max={200} />
        </div>
      </div>
      {activeEntry.type === 'box' && (
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Spread" property="boxShadow" plain />
          <div className="flex items-center gap-2 w-full">
            <ToolInput value={formatPx(activeEntry.spread)} onChange={(v) => updateEntry(activeIdx, { spread: parsePx(v) })} onChangeLive={(v) => updateEntryLive(activeIdx, { spread: parsePx(v) })} onCommit={(v) => updateEntry(activeIdx, { spread: parsePx(v) })} step={1} />
            <ToolPlusMinus value={activeEntry.spread} onChange={(v) => updateEntry(activeIdx, { spread: v })} min={-100} max={100} />
          </div>
        </div>
      )}
    </div>
    </ShowControlLabels>
  );
}

// ─── Inner atom ───────────────────────────────────────────────────────────────

function ShadowAtom() {
  const { value, node, onChange, onChangeMultiple, onChangeMultipleLive, binding, mode, allProps, hasVariable } = useControlContext();
  // When an injected chevron menu (Hoist Variable / Set Variable / Apply Preset) is present — i.e. this
  // Shadow atom is mounted on a component-INSTANCE prop row in variableDefault mode — the header label must
  // KEEP its chevron so the menu is reachable. Without this, Shadow was the only compound atom (vs Filter /
  // ClipPath / Fill) that force-plained its label in non-direct modes → no Hoist Variable for shadow.
  const ovHoist = useHoistMenuItem();
  const { isOpen, openPanel, panelPopup } = useEditorPanel('Shadow', () => (
    activeEntry && (
      <ShadowEditorPanel initialIdx={activeIdx} initialBoxShadow={boxShadow} initialFilter={filter} onChangeLive={onChangeMultipleLive} onCommit={onChangeMultiple} />
    )
  ));
  const styles = allProps;
  const allTokens = useAtomValue(presetTokensAtom);

  // boxShadow from unified context value (works in both direct and scrollStop modes)
  const boxShadow = value || '';
  const filter = styles.filter ?? '';

  const [entries, setEntries] = useState<ShadowEntry[]>(() => parseShadowEntries(boxShadow, filter));
  const [activeIdx, setActiveIdx] = useState<number>(0);
  const btnRef = useRef<HTMLElement>(null);

  // Skip re-sync when WE caused the change (not a node switch / undo / code edit)
  const selfWriteCountRef = useRef(0);

  // Re-sync when props change — but skip if we caused it
  const prevBoxRef = useRef(boxShadow);
  const prevFilterRef = useRef(filter);
  useEffect(() => {
    if (boxShadow !== prevBoxRef.current || filter !== prevFilterRef.current) {
      prevBoxRef.current = boxShadow;
      prevFilterRef.current = filter;
      if (selfWriteCountRef.current > 0) {
        selfWriteCountRef.current--;
        return; // We caused this — skip re-parse, keep activeIdx
      }
      // External change (node switch, undo, code edit) — re-parse and reset
      setEntries(parseShadowEntries(boxShadow, filter));
      setActiveIdx(0);
    }
  }, [boxShadow, filter]);

  // Commit entries back to CSS
  const commitEntries = (newEntries: ShadowEntry[]) => {
    // Re-assign deterministic IDs
    const withIds = newEntries.map((e, i) => ({ ...e, id: `shadow-${i}` }));
    setEntries(withIds);
    const { boxShadow: newBoxShadow, dropShadowFilter } = formatShadowEntries(withIds);
    trace.action('shadow:commit', { count: withIds.length, boxShadow: newBoxShadow.slice(0, 60), dropFilter: dropShadowFilter.slice(0, 60) });
    // We write 2 props (boxShadow + filter) — each may trigger a separate effect fire
    selfWriteCountRef.current = 2;
    const merged = mergeFilterWithDropShadows(filter, dropShadowFilter);
    onChangeMultiple({ boxShadow: newBoxShadow, filter: merged });
  };

  // Update a single entry
  const updateEntry = (idx: number, patch: Partial<ShadowEntry>) => {
    const updated = entries.map((e, i) => i === idx ? { ...e, ...patch } : e);
    commitEntries(updated);
  };

  const activeEntry = entries[activeIdx];

  trace.fn('ShadowAtom:render', { entryCount: entries.length, activeIdx, isOpen });

  // Bound check — show UsedByRow for animation/scroll, or the purple variable
  // pill when a component prop drives this style. Variable wins only if the
  // animation isn't already taking the slot — same priority as ControlRow.
  if (mode === 'direct' && binding.bound) {
    return (
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Shadow" property="boxShadow" />
        <UsedByRow binding={binding} />
      </div>
    );
  }
  if (mode === 'direct' && hasVariable) {
    return (
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Shadow" property="boxShadow" />
        <VariableBoundPill propertyLabel="Shadow" />
      </div>
    );
  }

  const openEditor = (idx: number, freshBoxShadow?: string) => {
    setActiveIdx(idx);
    openPanel(<ShadowEditorPanel initialIdx={idx} initialBoxShadow={freshBoxShadow ?? boxShadow} initialFilter={filter} onChangeLive={onChangeMultipleLive} onCommit={onChangeMultiple} />);
  };

  const handleAdd = () => {
    if (entries.length === 0) {
      const def = createDefaultShadow();
      const fresh = [def];
      commitEntries(fresh);
      const { boxShadow: freshBS } = formatShadowEntries(fresh);
      openEditor(0, freshBS);
    } else {
      const newEntry: ShadowEntry = { ...createDefaultShadow(), id: `shadow-${entries.length}` };
      const newEntries = [...entries, newEntry];
      const newIdx = newEntries.length - 1;
      commitEntries(newEntries);
      const { boxShadow: freshBS } = formatShadowEntries(newEntries);
      openEditor(newIdx, freshBS);
    }
  };

  const handleRemove = (idx: number) => {
    const n = [...entries];
    n.splice(idx, 1);
    commitEntries(n);
  };

  // Shadow preset reference: when boxShadow is exactly `var(--shadow-...)`, the
  // EntryList view (which expects parsed shadow entries) doesn't really apply
  // — show a blue-pill row instead, mirroring the color/image/video preset
  // affordance in FillControl. The pill swatch uses the resolved shadow's
  // color so the user gets a quick visual hint.
  const presetMatch = boxShadow.match(/^var\(\s*--([^)\s,]+)\s*\)$/);
  const shadowPresetToken = presetMatch
    ? allTokens.find(t => t.name === presetMatch[1] && t.category === 'shadow')
    : undefined;

  if (shadowPresetToken && mode !== 'preset') {
    return (
      <ShadowPresetPillRow
        tokenName={shadowPresetToken.name}
        tokenLabel={shadowPresetToken.label
          || shadowPresetToken.name.replace(/^shadow-/, '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
        currentValue={shadowPresetToken.value}
        previewColor={(() => {
          const entries = parseShadowEntries(shadowPresetToken.value, '');
          return entries[0] ? resolvePresetColor(entries[0].color, allTokens) : '#000';
        })()}
        onClear={() => onChange('')}
      />
    );
  }

  return (
    <>
      <EntryList
        label="Shadow"
        property="boxShadow"
        entries={entries}
        onEdit={openEditor}
        onRemove={handleRemove}
        onAdd={handleAdd}
        renderSwatch={(e) => ({ backgroundColor: resolvePresetColor(e.color, allTokens) })}
        renderLabel={(e) => e.type === 'drop' ? 'Drop' : shadowSummary(e)}
        addButtonRef={btnRef}
        EmptyIcon={ShadowIcon}
        nonInteractive={mode === 'preset'}
        plainLabel={mode !== 'direct' && !ovHoist}
      />

      {/* Shadow entry editor popup — only when NOT inside a parent popup */}
      {panelPopup(btnRef)}
    </>
  );
}

// ─── Shadow preset pill row — opens an edit popup on click ─────────────────

/**
 * The blue pill the row collapses to when a shadow preset is applied to the
 * node. Click → opens a ToolPopup that edits the preset *itself* (live updates
 * to the token write to tokens.css and propagate everywhere the preset is
 * used). × → unlinks the preset from this node only (caller's onClear).
 */
function ShadowPresetPillRow({ tokenName, tokenLabel, currentValue, previewColor, onClear }: {
  tokenName: string;
  tokenLabel: string;
  currentValue: string;
  previewColor: string;
  onClear: () => void;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const bumpVersion = useSetAtom(projectVersionAtom);

  // Live preset edit: liveUpdatePresetToken paints the canvas immediately
  // via the bridge's setCanvasTokenVar AND queues the tokens.css write. We
  // debounce the version bump (which fans out to every preset consumer) so
  // a dragged X/Y/blur slider doesn't trigger a re-render storm.
  const debouncedBump = useDebouncedCallback(() => bumpVersion(v => v + 1), 300);
  const handleEditChange = useCallback((newValue: string) => {
    liveUpdatePresetToken(tokenName, newValue);
    debouncedBump.call();
    trace.action('shadow-preset:edit', { tokenName });
  }, [tokenName, debouncedBump]);

  // Final bump on close so any final value is captured by the derived atoms.
  useEffect(() => {
    return () => {
      debouncedBump.cancel();
      bumpVersion(v => v + 1);
    };
  }, [bumpVersion, debouncedBump]);

  return (
    <>
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Shadow" property="boxShadow" />
        <button
          ref={anchorRef}
          className="w-full h-8 flex items-center gap-2 px-2 bg-[var(--accent)] rounded-[var(--radius-lg)] cursor-pointer transition-colors min-w-0 overflow-hidden hover:opacity-90"
          onClick={() => setEditOpen(true)}
        >
          <ColorSwatch style={{ backgroundColor: previewColor }} />
          <span className="text-xs font-medium text-white truncate flex-1 text-left">
            {tokenLabel}
          </span>
          <span
            onClick={(e) => { e.stopPropagation(); onClear(); }}
            className="text-white/70 hover:text-white text-sm leading-none cursor-pointer shrink-0"
          >
            &times;
          </span>
        </button>
      </div>

      {editOpen && (
        <ToolPopup
          isOpen={editOpen}
          onClose={() => setEditOpen(false)}
          title={`Edit "${tokenLabel}"`}
          anchorRef={anchorRef}
          width={260}
        >
          <ShadowControl
            mode="preset"
            externalValue={currentValue}
            externalOnChange={handleEditChange}
          />
        </ToolPopup>
      )}
    </>
  );
}

// ─── Exported wrapper ─────────────────────────────────────────────────────────

export function ShadowControl({ mode = 'direct', ...mp }: AtomProps) {
  return (
    <UnifiedControlProvider property="boxShadow" defaultValue="" mode={mode} {...mp}>
      <ShadowAtom />
    </UnifiedControlProvider>
  );
}
