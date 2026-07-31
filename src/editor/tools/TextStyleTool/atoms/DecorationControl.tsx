// DecorationControl.tsx — Text decoration popup control.
// Button row with preview: color swatch + "UNDERLINE" + RemoveButton.
// Click opens ToolPopup with: Type dropdown, Color, Style dropdown, Thickness slider, Offset slider.
// Supports external value/onChange for preset editing.
//
// Preset format: valid CSS text-decoration shorthand: "underline solid #a72222" or "none"
// Inner mode: sets individual CSS properties (textDecorationLine, textDecorationColor, etc.)

import { useRef, useState, useCallback, useEffect } from 'react';
import { ToolSelect, ToolSlider, ToolInput, ControlLabel, ColorInput, ControlActionRow, ColorSwatch, RemoveButton } from '../../../controls';
import { TextDecorationIcon } from '@/design-system/PropertyIcons';
import { getCSSPropertyOptions } from '../../../controls/css-property-options';
import { useTextStyles } from '../../../hooks/useTextStyles';
import { useControl } from '../../../controls/ControlProvider';
import ToolPopup, { useToolPopupOptional } from '../../../ui/ToolPopup';
import { trace } from '@/shared/debug-trace';
import { parseDecoShorthand, formatDecoShorthand } from './decoration-helpers';
import type { DecorationValues } from './decoration-helpers';

interface DecorationControlProps {
  value?: string;
  onChange?: (value: string) => void;
}

// ─── Panel Content ────────────────────────────────────────────────────────────

/** Self-contained panel content — manages its own state so slider drag works.
 *  Calls onCommit(fullVals) with the FULL state on every change.
 *  compact=true hides thickness/offset (for preset editing). */
function DecorationPanelContent({ initial, onCommit, compact }: {
  initial: DecorationValues;
  onCommit: (vals: DecorationValues) => void;
  compact?: boolean;
}) {
  const [vals, setVals] = useState<DecorationValues>(() => ({ ...initial }));

  // External re-seed (undo/redo while this editor is open): the parsed value
  // comes back through the prop — re-seed when it changed. Own commits are
  // skipped via the self-write counter so live/mid-drag state is never
  // clobbered by the round-trip (ShadowControl's pattern).
  const initSig = JSON.stringify(initial);
  const selfWriteRef = useRef(0);
  const prevInitSigRef = useRef(initSig);
  useEffect(() => {
    if (initSig === prevInitSigRef.current) return;
    prevInitSigRef.current = initSig;
    if (selfWriteRef.current > 0) { selfWriteRef.current--; return; }
    setVals({ ...initial });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initSig]);

  const update = (patch: Partial<DecorationValues>) => {
    const next = { ...vals, ...patch };
    setVals(next);
    selfWriteRef.current++;
    onCommit(next);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <ControlLabel label="Type" property="textDecorationLine" plain />
        <ToolSelect value={vals.line} onChange={(v) => update({ line: v })}
          options={getCSSPropertyOptions('textDecorationLine')!} />
      </div>
      <div className="flex items-center justify-between">
        <ControlLabel label="Color" property="textDecorationColor" plain />
        <ColorInput value={vals.color} onChange={(c) => update({ color: c })} />
      </div>
      <div className="flex items-center justify-between">
        <ControlLabel label="Style" property="textDecorationStyle" plain />
        <ToolSelect value={vals.style} onChange={(v) => update({ style: v })}
          options={getCSSPropertyOptions('textDecorationStyle')!} />
      </div>
      {!compact && (
        <>
          <div className="flex items-center justify-between">
            <ControlLabel label="Thickness" property="textDecorationThickness" plain />
            <div className="flex items-center gap-2 w-full">
              <ToolSlider value={vals.thickness} min={0} max={20} step={0.5} onChange={(v) => update({ thickness: v })} />
              <ToolInput value={String(vals.thickness)} onChange={(v) => update({ thickness: parseFloat(v) || 1 })} step={0.5} />
            </div>
          </div>
          <div className="flex items-center justify-between">
            <ControlLabel label="Offset" property="textUnderlineOffset" plain />
            <div className="flex items-center gap-2 w-full">
              <ToolSlider value={vals.offset} min={-10} max={20} step={1} onChange={(v) => update({ offset: v })} />
              <ToolInput value={String(vals.offset)} onChange={(v) => update({ offset: parseFloat(v) || 0 })} step={1} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Inner (text editing context) ─────────────────────────────────────────────

function DecorationInner() {
  const text = useTextStyles();
  const { styles, updateStyle } = useControl();
  const rowRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const popupCtx = useToolPopupOptional();

  const decoLine = (text.isEditing ? text.get('textDecorationLine').value : styles.textDecorationLine) || 'none';
  const decoColor = (text.isEditing ? text.get('textDecorationColor').value : styles.textDecorationColor) || '#000000';
  const decoStyle = (text.isEditing ? text.get('textDecorationStyle').value : styles.textDecorationStyle) || 'solid';
  const decoThickness = parseFloat((text.isEditing ? text.get('textDecorationThickness').value : styles.textDecorationThickness) || '1') || 1;
  const decoOffset = parseFloat((text.isEditing ? text.get('textUnderlineOffset').value : styles.textUnderlineOffset) || '0') || 0;

  const setDeco = useCallback((prop: string, val: string) => {
    if (text.isEditing) text.set(prop, val);
    else updateStyle(prop, val);
  }, [text, updateStyle]);

  const handleCommit = useCallback((vals: DecorationValues) => {
    setDeco('textDecorationLine', vals.line);
    setDeco('textDecorationColor', vals.color);
    setDeco('textDecorationStyle', vals.style);
    setDeco('textDecorationThickness', `${vals.thickness}px`);
    setDeco('textUnderlineOffset', `${vals.offset}px`);
  }, [setDeco]);

  const handleClick = () => {
    const initial: DecorationValues = { line: decoLine, color: decoColor, style: decoStyle, thickness: decoThickness, offset: decoOffset };
    if (popupCtx) {
      popupCtx.pushPanel('Decoration', <DecorationPanelContent initial={initial} onCommit={handleCommit} />);
    } else {
      setIsOpen(true);
    }
  };

  const handleRemove = () => {
    if (text.isEditing) text.set('textDecorationLine', 'none');
    else updateStyle('textDecorationLine', 'none');
  };

  trace.fn('DecorationInner:render', { decoLine, isOpen });

  return (
    <>
      <div ref={rowRef} className="flex items-center justify-between w-full">
        <ControlLabel label="Decoration" property="textDecorationLine" />
        <ControlActionRow onClick={handleClick}>
          {decoLine !== 'none' ? (
            <>
              <ColorSwatch style={{ backgroundColor: decoColor }} />
              <span className="text-xs truncate flex-1 uppercase">{decoLine.replace(/-/g, ' ')}</span>
              <RemoveButton onClick={handleRemove} />
            </>
          ) : (
            <>
              <TextDecorationIcon width={20} height={20} bg="var(--control-border)" className="shrink-0 opacity-50" />
              <span className="text-[var(--text-secondary)]">Add</span>
            </>
          )}
        </ControlActionRow>
      </div>
      {!popupCtx && (
        <ToolPopup isOpen={isOpen} onClose={() => setIsOpen(false)} title="Text Decoration" anchorRef={rowRef}>
          <DecorationPanelContent
            initial={{ line: decoLine, color: decoColor, style: decoStyle, thickness: decoThickness, offset: decoOffset }}
            onCommit={handleCommit}
          />
        </ToolPopup>
      )}
    </>
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Public API — supports external value/onChange for preset editing */
export function DecorationControl({ value, onChange }: DecorationControlProps = {}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [localVals, setLocalVals] = useState<DecorationValues>(() => parseDecoShorthand(value || 'none'));
  const popupCtx = useToolPopupOptional();

  if (value !== undefined && onChange !== undefined) {
    const handleCommit = (vals: DecorationValues) => {
      trace.action('DecorationControl:external-commit', { line: vals.line, color: vals.color, style: vals.style });
      setLocalVals(vals);
      onChange(formatDecoShorthand(vals));
    };

    const handleClick = () => {
      if (popupCtx) {
        popupCtx.pushPanel('Decoration', <DecorationPanelContent initial={localVals} onCommit={handleCommit} compact />);
      } else {
        setIsOpen(true);
      }
    };

    const handleRemove = () => {
      const reset: DecorationValues = { line: 'none', color: '#000000', style: 'solid', thickness: 1, offset: 0 };
      setLocalVals(reset);
      onChange('none');
    };

    return (
      <>
        <div ref={rowRef} className="flex items-center justify-between w-full">
          <ControlLabel label="Decoration" property="textDecorationLine" plain />
          <ControlActionRow onClick={handleClick}>
            {localVals.line !== 'none' ? (
              <>
                <ColorSwatch style={{ backgroundColor: localVals.color }} />
                <span className="text-xs truncate flex-1 uppercase">{localVals.line.replace(/-/g, ' ')}</span>
                <RemoveButton onClick={handleRemove} />
              </>
            ) : (
              <>
              <TextDecorationIcon width={20} height={20} bg="var(--control-border)" className="shrink-0 opacity-50" />
              <span className="text-[var(--text-secondary)]">Add</span>
            </>
            )}
          </ControlActionRow>
        </div>
        {!popupCtx && (
          <ToolPopup isOpen={isOpen} onClose={() => setIsOpen(false)} title="Text Decoration" anchorRef={rowRef}>
            <DecorationPanelContent initial={localVals} onCommit={handleCommit} compact />
          </ToolPopup>
        )}
      </>
    );
  }
  return <DecorationInner />;
}
