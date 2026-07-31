// ShadowControl.tsx — Multi-entry text-shadow control.
//
// Mirrors the StylesTool box-shadow control (EntryList + per-entry editor popup) so the user can stack
// SEVERAL text shadows on one element — `text-shadow: 1px 1px 2px red, 0 0 5px blue` — exactly like
// the reference. Text-shadow is simpler than box-shadow (just X / Y / Blur / Color per layer — no spread, no
// inset, no drop-shadow split), so it reuses the shared `EntryList` UI with text-shadow utilities.
//
// Supports external value/onChange for preset editing.

import { useRef, useState, useCallback, useEffect } from 'react';
import { ToolSlider, ToolInput, ControlLabel, ColorInput, EntryList } from '../../../controls';
import { useControl } from '../../../controls/ControlProvider';
import ToolPopup, { useToolPopupOptional } from '../../../ui/ToolPopup';
import { ShadowIcon } from '@/design-system/PropertyIcons';
import {
  parseTextShadowEntries, formatTextShadowEntries,
  createDefaultTextShadow, textShadowSummary,
  type TextShadowEntry,
} from '../text-helpers';
import { trace } from '@/shared/debug-trace';

interface ShadowControlProps {
  value?: string;
  onChange?: (value: string) => void;
}

// ─── Per-entry editor panel (X / Y / Blur / Color for one layer) ─────────────
// Holds the FULL entry list + the active index so a single-field edit re-formats and commits the whole
// `text-shadow` value (other layers preserved). Self-contained state so slider drag stays smooth.

function TextShadowEditorPanel({ initialIdx, initialValue, onCommit }: {
  initialIdx: number;
  initialValue: string;
  onCommit: (value: string) => void;
}) {
  const [entries, setEntries] = useState<TextShadowEntry[]>(() => parseTextShadowEntries(initialValue));
  const activeIdx = initialIdx;
  const activeEntry = entries[activeIdx];

  // External re-seed (undo/redo while this editor is open): the parsed value
  // comes back through the prop — re-seed when it changed. Own commits are
  // skipped via the self-write counter so live/mid-drag state is never
  // clobbered by the round-trip (ShadowControl's pattern).
  const selfWriteRef = useRef(0);
  const prevInitRef = useRef(initialValue);
  useEffect(() => {
    if (initialValue === prevInitRef.current) return;
    prevInitRef.current = initialValue;
    if (selfWriteRef.current > 0) { selfWriteRef.current--; return; }
    setEntries(parseTextShadowEntries(initialValue));
  }, [initialValue]);

  const updateEntry = (patch: Partial<TextShadowEntry>) => {
    const updated = entries.map((e, i) => (i === activeIdx ? { ...e, ...patch } : e));
    setEntries(updated);
    selfWriteRef.current++;
    onCommit(formatTextShadowEntries(updated));
  };

  if (!activeEntry) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <ControlLabel label="X Offset" property="textShadow" plain />
        <div className="flex items-center gap-2 w-full">
          <ToolSlider value={activeEntry.x} min={-50} max={50} step={1} onChange={(v) => updateEntry({ x: v })} />
          <ToolInput value={String(activeEntry.x)} onChange={(v) => updateEntry({ x: parseFloat(v) || 0 })} step={1} />
        </div>
      </div>
      <div className="flex items-center justify-between">
        <ControlLabel label="Y Offset" property="textShadow" plain />
        <div className="flex items-center gap-2 w-full">
          <ToolSlider value={activeEntry.y} min={-50} max={50} step={1} onChange={(v) => updateEntry({ y: v })} />
          <ToolInput value={String(activeEntry.y)} onChange={(v) => updateEntry({ y: parseFloat(v) || 0 })} step={1} />
        </div>
      </div>
      <div className="flex items-center justify-between">
        <ControlLabel label="Blur" property="textShadow" plain />
        <div className="flex items-center gap-2 w-full">
          <ToolSlider value={activeEntry.blur} min={0} max={50} step={1} onChange={(v) => updateEntry({ blur: v })} />
          <ToolInput value={String(activeEntry.blur)} onChange={(v) => updateEntry({ blur: parseFloat(v) || 0 })} step={1} />
        </div>
      </div>
      <div className="flex items-center justify-between">
        <ControlLabel label="Color" property="textShadow" plain />
        <ColorInput value={activeEntry.color} onChange={(c) => updateEntry({ color: c })} showAlpha />
      </div>
    </div>
  );
}

// ─── Shared list (EntryList + add/edit/remove) ───────────────────────────────

function TextShadowList({ value, onCommit, plain }: {
  value: string;
  onCommit: (value: string) => void;
  plain?: boolean;
}) {
  const popupCtx = useToolPopupOptional();
  const rowRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);

  const entries = parseTextShadowEntries(value);

  trace.fn('TextShadowList:render', { count: entries.length, isOpen, plain });

  const openEditor = (idx: number, freshValue?: string) => {
    setActiveIdx(idx);
    if (popupCtx) {
      popupCtx.pushPanel('Text Shadow', <TextShadowEditorPanel initialIdx={idx} initialValue={freshValue ?? value} onCommit={onCommit} />);
    } else {
      setIsOpen(true);
    }
  };

  const handleAdd = () => {
    const newEntries = [...entries, createDefaultTextShadow(entries.length)];
    const v = formatTextShadowEntries(newEntries);
    onCommit(v);
    openEditor(newEntries.length - 1, v);
  };

  const handleRemove = (idx: number) => {
    const n = [...entries];
    n.splice(idx, 1);
    onCommit(formatTextShadowEntries(n));
  };

  return (
    <>
      <EntryList
        label="Shadow"
        property="textShadow"
        entries={entries}
        onEdit={(i) => openEditor(i)}
        onRemove={handleRemove}
        onAdd={handleAdd}
        renderSwatch={(e) => ({ backgroundColor: e.color })}
        renderLabel={(e) => textShadowSummary(e)}
        addButtonRef={rowRef}
        EmptyIcon={ShadowIcon}
        nonInteractive={plain}
        plainLabel={plain}
      />
      {!popupCtx && (
        <ToolPopup isOpen={isOpen} onClose={() => setIsOpen(false)} title="Text Shadow" anchorRef={rowRef}>
          {entries[activeIdx] && (
            <TextShadowEditorPanel initialIdx={activeIdx} initialValue={value} onCommit={onCommit} />
          )}
        </ToolPopup>
      )}
    </>
  );
}

// ─── Inner component for text editing context ────────────────────────────────

function ShadowInner() {
  const { styles, updateStyle } = useControl();
  const shadow = styles.textShadow || 'none';
  const handleCommit = useCallback((v: string) => updateStyle('textShadow', v), [updateStyle]);
  return <TextShadowList value={shadow} onCommit={handleCommit} />;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function ShadowControl({ value, onChange }: ShadowControlProps = {}) {
  const [localShadow, setLocalShadow] = useState(value || 'none');

  if (value !== undefined && onChange !== undefined) {
    const handleCommit = (v: string) => {
      setLocalShadow(v);
      onChange(v);
    };
    return <TextShadowList value={localShadow} onCommit={handleCommit} plain />;
  }
  return <ShadowInner />;
}
