// StrokeControl.tsx — Text stroke popup control.
// Button row with preview: color swatch + "WPXPX" + RemoveButton.
// Click opens ToolPopup with: Width slider + Color picker.
// Uses text.get/set('webkitTextStroke') for TipTap-aware property.

import { useRef, useState, useCallback } from 'react';
import { ToolSlider, ToolInput, ControlLabel, ColorInput, ControlActionRow, ColorSwatch, RemoveButton } from '../../../controls';
import { TextStrokeIcon } from '@/design-system/PropertyIcons';
import { useTextStyles } from '../../../hooks/useTextStyles';
import { useControl } from '../../../controls/ControlProvider';
import ToolPopup from '../../../ui/ToolPopup';
import { trace } from '@/shared/debug-trace';

export function StrokeControl() {
  const text = useTextStyles();
  const rowRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const { styles, updateStyle, updateStyleLive } = useControl();

  // Read from TipTap marks if editing
  const strokeVal = text.isEditing ? text.get('webkitTextStroke').value : (styles.WebkitTextStroke || styles.webkitTextStroke || '');
  const strokeParts = strokeVal.match(/(-?\d+\.?\d*)px\s+(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))/);
  const strokeWidth = strokeParts ? parseFloat(strokeParts[1]) : 0;
  const strokeColor = strokeParts ? strokeParts[2] : '#000000';

  const setStroke = useCallback((w: number, c: string) => {
    const val = w === 0 ? '' : `${w}px ${c}`;
    if (text.isEditing) text.set('webkitTextStroke', val);
    else updateStyle('WebkitTextStroke', val);
  }, [text, updateStyle]);

  // Live (per-frame) twin for picker/slider drags — DOM-only patch in node
  // mode (no re-parse), TipTap live in edit mode. Commit lands on release via
  // setStroke.
  const setStrokeLive = useCallback((w: number, c: string) => {
    const val = w === 0 ? '' : `${w}px ${c}`;
    if (text.isEditing) text.setLive('webkitTextStroke', val);
    else updateStyleLive('WebkitTextStroke', val);
  }, [text, updateStyleLive]);

  trace.fn('StrokeControl:render', { strokeVal, strokeWidth, strokeColor, isEditing: text.isEditing, isOpen });

  return (
    <>
      <div ref={rowRef} className="flex items-center justify-between w-full">
        <ControlLabel label="Stroke" property="WebkitTextStroke" />
        <ControlActionRow onClick={() => setIsOpen(true)}>
          {strokeWidth > 0 ? (
            <>
              <ColorSwatch style={{ backgroundColor: strokeColor }} />
              <span className="text-xs truncate flex-1">
                {strokeWidth}PX
              </span>
              <RemoveButton onClick={() => setStroke(0, strokeColor)} />
            </>
          ) : (
            <>
              <TextStrokeIcon width={20} height={20} bg="var(--control-border)" className="shrink-0 opacity-50" />
              <span className="text-[var(--text-secondary)]">Add</span>
            </>
          )}
        </ControlActionRow>
      </div>
      <ToolPopup isOpen={isOpen} onClose={() => setIsOpen(false)} title="Text Stroke" anchorRef={rowRef}>
        {/* Own gap-2 wrapper: Width + Color rows are otherwise direct children of
            the popup content (shared gap-3.5) — wrapping tightens ONLY this popup. */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <ControlLabel label="Width" property="WebkitTextStroke" plain />
            <div className="flex items-center gap-2 w-full">
              <ToolSlider value={strokeWidth} min={0} max={10} step={0.5} onChange={(v) => setStrokeLive(v, strokeColor)} onCommit={(v) => setStroke(v, strokeColor)} />
              <ToolInput value={String(strokeWidth)} onChange={(v) => setStroke(parseFloat(v) || 0, strokeColor)} onChangeLive={(v) => setStrokeLive(parseFloat(v) || 0, strokeColor)} onCommit={(v) => setStroke(parseFloat(v) || 0, strokeColor)} step={0.5} />
            </div>
          </div>
          <div className="flex items-center justify-between">
            <ControlLabel label="Color" property="WebkitTextStroke" plain />
            <ColorInput value={strokeColor} onChange={(c) => setStroke(strokeWidth, c)} onChangeLive={(c) => setStrokeLive(strokeWidth, c)} />
          </div>
        </div>
      </ToolPopup>
    </>
  );
}
