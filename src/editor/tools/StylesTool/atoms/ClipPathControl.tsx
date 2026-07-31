// ClipPathControl.tsx — Self-contained clip-path ToolAtom.
// Uses pushPanel when inside a popup context, standalone ToolPopup otherwise.

import { useState, useRef, useEffect, useCallback } from 'react';
import { useSetAtom, useAtomValue } from 'jotai';
import { ClipPathIcon } from '@/design-system/PropertyIcons';
import { UnifiedControlProvider, useControlContext } from '../../../controls/unified';
import { UsedByRow } from '../../../controls/unified/UsedByRow';
import { VariableBoundPill } from '../../../controls/VariableBoundPill';
import { ToolInput, ToolSegmentedControl, ControlLabel, SingleEntryRow } from '../../../controls';
import { useOverriddenLabel } from '../../../controls/label-override-context';
import { useHoistMenuItem } from '../../../controls/hoist-context';
import { useEditorPanel } from '../../../hooks/useEditorPanel';
import {
  parseClipPath, formatClipPath, createDefaultClipPath,
  CLIPPATH_PRESETS, presetToPoints,
  type ClipPathData, type ClipPathType,
} from '@/shared/clippath-utils';
import { activeClipPathAtom, clipPathUpdateCallbackAtom, clipPathCommitCallbackAtom } from '@/code/stores/clippath-store';
import { selectedIdsAtom } from '@/code/stores/store';
import { updateNodeStyles, getContentRoot } from '@/canvas/node-ops';
import { trace } from '@/shared/debug-trace';
import type { AtomProps } from '../../../controls/unified/types';

// ─── Self-contained editor (owns state + overlay, works in pushPanel & ToolPopup) ─

interface ClipPathEditorProps {
  initialData: ClipPathData;
  /** Called when editor writes a new value — parent uses this to sync its state */
  onWrite: (d: ClipPathData, css: string) => void;
  /** Whether to show the drag overlay on canvas */
  showOverlay: boolean;
}

function ClipPathEditor({ initialData, onWrite, showOverlay }: ClipPathEditorProps) {
  const [data, setData] = useState<ClipPathData>(initialData);
  const dataRef = useRef(data);
  dataRef.current = data;
  const onWriteRef = useRef(onWrite);
  onWriteRef.current = onWrite;

  // External re-seed (undo/redo while the clip editor is open): the parsed
  // clip comes back via `initialData`. Value-compare against LOCAL state
  // doubles as the self-write guard — own writes round-trip to the same
  // data, so the reseed is a no-op for them.
  const initSig = JSON.stringify(initialData);
  const prevInitSigRef = useRef(initSig);
  useEffect(() => {
    if (initSig === prevInitSigRef.current) return;
    prevInitSigRef.current = initSig;
    if (JSON.stringify(dataRef.current) === initSig) return;
    setData(initialData);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initSig]);

  // Overlay atoms
  const setActiveClipPath = useSetAtom(activeClipPathAtom);
  const setClipPathCallback = useSetAtom(clipPathUpdateCallbackAtom);
  const setClipPathCommit = useSetAtom(clipPathCommitCallbackAtom);
  const selectedIds = useAtomValue(selectedIdsAtom);
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;

  // Set up overlay on mount, clean up on unmount
  useEffect(() => {
    if (!showOverlay) return;
    setActiveClipPath(dataRef.current);

    // LIVE — fires on every drag pointermove. DOM-only inline patch + atom
    // update. NO mutation queue / parser / renderer cycle (those would race
    // with the next pointermove and cause oscillation).
    setClipPathCallback(() => (updated: ClipPathData) => {
      dataRef.current = updated;
      setData(updated);
      setActiveClipPath(updated);
      const css = formatClipPath(updated);
      const contentEl = getContentRoot();
      if (contentEl) {
        for (const id of selectedIdsRef.current) {
          updateNodeStyles({ id, styles: { clipPath: css }, contentEl, domOnly: true });
        }
      }
    });

    // COMMIT — fires once on drag pointerup. The only write that goes through
    // the mutation queue / code generator.
    setClipPathCommit(() => (updated: ClipPathData) => {
      const css = formatClipPath(updated);
      onWriteRef.current(updated, css);
      trace.action('clippath:editor-commit', { type: updated.type, css: css.slice(0, 60) });
    });

    return () => {
      setActiveClipPath(null);
      setClipPathCallback(null);
      setClipPathCommit(null);
    };
  }, [showOverlay, setActiveClipPath, setClipPathCallback, setClipPathCommit]);

  // Editor-side writes (text inputs, type switch, presets) — go through the
  // regular path immediately. These are single-shot, not continuous-drag, so
  // there's no race with the renderer.
  const write = useCallback((d: ClipPathData) => {
    setData(d);
    if (showOverlay) setActiveClipPath(d);
    const css = formatClipPath(d);
    trace.action('clippath:editor-write', { type: d.type, css: css.slice(0, 60) });
    onWriteRef.current(d, css);
  }, [showOverlay, setActiveClipPath]);

  return (
    <div className="flex flex-col gap-2">
      <ToolSegmentedControl
        value={data.type}
        onChange={(v) => write(createDefaultClipPath(v as ClipPathType))}
        options={[
          { value: 'polygon', label: 'Polygon' },
          { value: 'circle', label: 'Circle' },
          { value: 'ellipse', label: 'Ellipse' },
          { value: 'inset', label: 'Inset' },
        ]}
        size="sm"
      />

      {data.type === 'polygon' && (
        <div className="grid grid-cols-6 gap-1">
          {CLIPPATH_PRESETS.map((preset) => (
            <button key={preset.name}
              onClick={() => write({ ...data, points: presetToPoints(preset.points) })}
              title={preset.name}
              className="h-8 w-full bg-[var(--choice-bg)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] rounded transition-colors relative overflow-hidden cursor-pointer">
              <div className="absolute inset-1 bg-[var(--text-secondary)]"
                style={{ clipPath: `polygon(${preset.points.map(([x, y]) => `${x}% ${y}%`).join(', ')})` }} />
            </button>
          ))}
        </div>
      )}

      {data.type === 'polygon' && (
        <div className="flex items-center justify-between">
          <ControlLabel label="Points" property="clipPath" plain />
          <span className="text-xs text-[var(--text-primary)]">{data.points.length}</span>
        </div>
      )}

      {data.type === 'circle' && (
        <>
          <div className="flex items-center justify-between">
            <ControlLabel label="Radius" property="clipPath" plain />
            <ToolInput value={`${Math.round(data.radius)}%`} onChange={(v) => write({ ...data, radius: parseFloat(v) || 50 })} step={1} />
          </div>
          <div className="flex items-center justify-between">
            <ControlLabel label="Center X" property="clipPath" plain />
            <ToolInput value={`${Math.round(data.centerX)}%`} onChange={(v) => write({ ...data, centerX: parseFloat(v) || 50 })} step={1} />
          </div>
          <div className="flex items-center justify-between">
            <ControlLabel label="Center Y" property="clipPath" plain />
            <ToolInput value={`${Math.round(data.centerY)}%`} onChange={(v) => write({ ...data, centerY: parseFloat(v) || 50 })} step={1} />
          </div>
        </>
      )}

      {data.type === 'ellipse' && (
        <>
          <div className="flex items-center justify-between">
            <ControlLabel label="Radius X" property="clipPath" plain />
            <ToolInput value={`${Math.round(data.radiusX)}%`} onChange={(v) => write({ ...data, radiusX: parseFloat(v) || 50 })} step={1} />
          </div>
          <div className="flex items-center justify-between">
            <ControlLabel label="Radius Y" property="clipPath" plain />
            <ToolInput value={`${Math.round(data.radiusY)}%`} onChange={(v) => write({ ...data, radiusY: parseFloat(v) || 40 })} step={1} />
          </div>
          <div className="flex items-center justify-between">
            <ControlLabel label="Center X" property="clipPath" plain />
            <ToolInput value={`${Math.round(data.centerX)}%`} onChange={(v) => write({ ...data, centerX: parseFloat(v) || 50 })} step={1} />
          </div>
          <div className="flex items-center justify-between">
            <ControlLabel label="Center Y" property="clipPath" plain />
            <ToolInput value={`${Math.round(data.centerY)}%`} onChange={(v) => write({ ...data, centerY: parseFloat(v) || 50 })} step={1} />
          </div>
        </>
      )}

      {data.type === 'inset' && (
        <>
          <div className="flex items-center justify-between">
            <ControlLabel label="Top" property="clipPath" plain />
            <ToolInput value={`${Math.round(data.top)}%`} onChange={(v) => write({ ...data, top: parseFloat(v) || 0 })} step={1} />
          </div>
          <div className="flex items-center justify-between">
            <ControlLabel label="Right" property="clipPath" plain />
            <ToolInput value={`${Math.round(data.right)}%`} onChange={(v) => write({ ...data, right: parseFloat(v) || 0 })} step={1} />
          </div>
          <div className="flex items-center justify-between">
            <ControlLabel label="Bottom" property="clipPath" plain />
            <ToolInput value={`${Math.round(data.bottom)}%`} onChange={(v) => write({ ...data, bottom: parseFloat(v) || 0 })} step={1} />
          </div>
          <div className="flex items-center justify-between">
            <ControlLabel label="Left" property="clipPath" plain />
            <ToolInput value={`${Math.round(data.left)}%`} onChange={(v) => write({ ...data, left: parseFloat(v) || 0 })} step={1} />
          </div>
          <div className="flex items-center justify-between">
            <ControlLabel label="Round" property="clipPath" plain />
            <ToolInput value={`${Math.round(data.round)}px`} onChange={(v) => write({ ...data, round: parseFloat(v) || 0 })} step={1} />
          </div>
        </>
      )}
    </div>
  );
}

// ─── Main Atom ───────────────────────────────────────────────────────────────

function ClipPathAtom() {
  const { value, onChange, binding, mode, hasVariable } = useControlContext();
  const btnRef = useRef<HTMLSpanElement>(null);

  const clipValue = value || '';
  const parsed = parseClipPath(clipValue);
  const hasClipPath = !!parsed;

  const { isOpen, openPanel, panelPopup } = useEditorPanel('Clip Path', () => (
    /* Overlay only in direct (single-node) editing — in a variable /
       hoisted-variable context there's no node to anchor the handles
       to (the clip-path lives on a nested child), so the canvas
       overlay would land on the wrong element. Edit via controls. */
    <ClipPathEditor initialData={data} onWrite={handleEditorWrite} showOverlay={mode === 'direct'} />
  ));
  const [data, setData] = useState<ClipPathData>(() => parsed || createDefaultClipPath());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const setActiveClipPath = useSetAtom(activeClipPathAtom);
  const selfWriteRef = useRef(false);

  // Sync from code on external value change
  const prevClipRef = useRef(clipValue);
  useEffect(() => {
    if (clipValue !== prevClipRef.current) {
      prevClipRef.current = clipValue;
      if (selfWriteRef.current) { selfWriteRef.current = false; return; }
      const p = parseClipPath(clipValue);
      if (p) setData(p);
    }
  }, [clipValue]);

  trace.fn('ClipPathAtom:render', { hasClipPath, type: data.type, isOpen });

  const { label: ovLabel, subLabel: ovSubLabel } = useOverriddenLabel('Clip Path');
  const ovHoist = useHoistMenuItem();
  const labelPlain = mode !== 'direct' && !ovHoist;

  if (mode === 'direct' && binding.bound) {
    return (
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Clip Path" property="clipPath" />
        <UsedByRow binding={binding} />
      </div>
    );
  }
  if (mode === 'direct' && hasVariable) {
    return (
      <div className="flex items-center justify-between w-full">
        <ControlLabel label="Clip Path" property="clipPath" />
        <VariableBoundPill propertyLabel="Clip Path" />
      </div>
    );
  }

  // Callback from editor — updates parent state + writes to code
  const handleEditorWrite = (d: ClipPathData, css: string) => {
    setData(d);
    if (mode === 'direct') selfWriteRef.current = true;
    onChangeRef.current(css);
  };

  const handleOpen = () => {
    let initialData = data;
    if (!hasClipPath) {
      initialData = createDefaultClipPath();
      setData(initialData);
      if (mode === 'direct') selfWriteRef.current = true;
      onChangeRef.current(formatClipPath(initialData));
    }
    openPanel(
      <ClipPathEditor initialData={initialData} onWrite={handleEditorWrite} showOverlay={mode === 'direct'} />
    );
  };

  return (
    <>
      <SingleEntryRow
        label={ovLabel} property="clipPath" plain={labelPlain} subLabel={ovSubLabel}
        hasValue={hasClipPath}
        onOpen={handleOpen}
        anchorRef={btnRef}
        EmptyIcon={ClipPathIcon}
        renderPreview={() => (
          <>
            <span className="w-5 h-5 flex-shrink-0 bg-[var(--text-secondary)]" style={{ clipPath: formatClipPath(data), borderRadius: 0 }} />
            <span className="truncate flex-1 capitalize">{data.type}</span>
          </>
        )}
        onRemove={() => { onChange(''); setActiveClipPath(null); }}
      />

      {panelPopup(btnRef)}
    </>
  );
}

export function ClipPathControl({ mode = 'direct', ...mp }: AtomProps) {
  return (
    <UnifiedControlProvider property="clipPath" defaultValue="" mode={mode} {...mp}>
      <ClipPathAtom />
    </UnifiedControlProvider>
  );
}
