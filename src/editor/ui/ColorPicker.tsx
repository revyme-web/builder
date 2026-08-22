// ColorPicker.tsx — Full color picker with saturation square, hue/alpha sliders,
// hex/rgb/hsl input modes, eyedropper, and clipboard copy.
// Uses pointer events for drag (per lesson 01). No third-party dependencies.

import { useState, useRef, useCallback, useEffect } from 'react';
import { useSetAtom } from 'jotai';
import { canvasInteractingAtom } from '@/code/stores/store';
import { colorPickerOpenAtom } from '@/code/stores/editor-store';
import { trace } from '@/shared/debug-trace';
import {
  type RGB, type HSV, type HSL,
  hexToRgb, rgbToHex, rgbToHsv, hsvToRgb, rgbToHsl, hslToRgb,
  parseColor, formatColor,
} from './color-utils';
import { clamp } from '@/canvas/canvas-math';
import { ColorSwatch } from '@/editor/controls/ColorSwatch';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ColorPickerProps {
  value: string;
  /** Fires on EVERY change (every drag frame). Route this to a cheap live
   *  preview when a caller also passes `onChangeEnd`. */
  onChange: (color: string) => void;
  /** Optional commit callback — fires ONCE: on drag pointer-up, and
   *  immediately for one-shot edits (hex/rgb/hsl input, eyedropper). Lets a
   *  caller keep `onChange` cheap (DOM preview) and do the code write here. */
  onChangeEnd?: (color: string) => void;
  showAlpha?: boolean;
  /** Called when user clicks "Create new color preset". Receives the current color hex. */
  onCreatePreset?: (color: string) => void;
  /** Color preset tokens to show as a list below the picker. */
  colorPresets?: Array<{ name: string; value: string; label?: string }>;
  /** Called when a preset is clicked (applies it). Receives the var(--name) CSS value. */
  onApplyPreset?: (varValue: string) => void;
  /** Called when "Edit" is clicked on a preset row. Receives the preset name. */
  onEditPreset?: (presetName: string) => void;
  /** Currently active preset name (for highlighting in the list). */
  activePresetName?: string;
}

type InputMode = 'hex' | 'rgb' | 'hsl';

// ─── Icons (inline SVG) ─────────────────────────────────────────────────────

function CopyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function EyedropperIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 22l1-1h3l9-9" />
      <path d="M3 21v-3l9-9" />
      <path d="M14.5 5.5l4-4a2.121 2.121 0 113 3l-4 4" />
      <path d="M12 8l4 4" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

// ─── Channel pill (RGB / HSL multi-input) ───────────────────────────────────
// The 3 channel inputs render as ONE connected segmented pill — borders
// shared via `-ml-[1px]`, only the outer corners rounded — matching the
// padding / radius SpacingControl pattern. Compact and visually unified.

function ChannelPill({ values, onChange, onCommit }: {
  values: string[];
  onChange: (index: number, value: string) => void;
  onCommit: () => void;
}) {
  return (
    <div className="flex flex-1 min-w-0">
      {values.map((val, i) => {
        const isFirst = i === 0;
        const isLast = i === values.length - 1;
        return (
          <input
            key={i}
            className={`flex-1 min-w-0 h-[var(--control-height-sm)] px-1.5 text-xs text-center bg-[var(--grid-line)] text-[var(--text-primary)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] focus:border-[var(--border-focus)] focus:outline-none focus:z-10 relative transition-colors ${isFirst ? 'rounded-l-[var(--radius-lg)]' : '-ml-[1px]'} ${isLast ? 'rounded-r-[var(--radius-lg)]' : ''}`}
            value={val}
            onChange={e => onChange(i, e.target.value)}
            onBlur={onCommit}
            onKeyDown={e => { if (e.key === 'Enter') { onCommit(); (e.target as HTMLInputElement).blur(); } }}
            spellCheck={false}
          />
        );
      })}
    </div>
  );
}

// ─── Hook: pointer drag on a bounded element ─────────────────────────────────

function usePointerDrag(
  onDrag: (x: number, y: number, rect: DOMRect) => void,
  setInteracting?: (v: boolean) => void,
) {
  const ref = useRef<HTMLDivElement>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const el = ref.current;
    if (!el) return;

    el.setPointerCapture(e.pointerId);
    setInteracting?.(true);
    const rect = el.getBoundingClientRect();
    onDrag(e.clientX - rect.left, e.clientY - rect.top, rect);

    const handleMove = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      onDrag(ev.clientX - r.left, ev.clientY - r.top, r);
    };

    const handleUp = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener('pointermove', handleMove);
      el.removeEventListener('pointerup', handleUp);
      setInteracting?.(false);
    };

    el.addEventListener('pointermove', handleMove);
    el.addEventListener('pointerup', handleUp);
  }, [onDrag, setInteracting]);

  return { ref, onPointerDown: handlePointerDown };
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function ColorPicker({ value, onChange, onChangeEnd, showAlpha = true, onCreatePreset, colorPresets, onApplyPreset, onEditPreset, activePresetName }: ColorPickerProps) {
  const setCanvasInteracting = useSetAtom(canvasInteractingAtom);
  const setColorPickerOpen = useSetAtom(colorPickerOpenAtom);

  // While this picker is mounted, flag color-editing so SelectionOverlay hides
  // its selection box + handles (the gradient / clip-path editing overlays stay
  // visible) — otherwise the selection chrome covers what you're dragging.
  useEffect(() => {
    setColorPickerOpen(true);
    return () => setColorPickerOpen(false);
  }, [setColorPickerOpen]);

  // Internal HSV state + alpha
  const [hsv, setHsv] = useState<HSV>(() => {
    const { rgb } = parseColor(value);
    return rgbToHsv(rgb);
  });
  const [alpha, setAlpha] = useState(() => parseColor(value).alpha);
  const [inputMode, setInputMode] = useState<InputMode>('hex');

  // Local text input states (updated on blur/Enter, not on every keystroke)
  const [hexInput, setHexInput] = useState('');
  const [rgbInputs, setRgbInputs] = useState({ r: '', g: '', b: '' });
  const [hslInputs, setHslInputs] = useState({ h: '', s: '', l: '' });
  const [alphaInput, setAlphaInput] = useState('');
  // Copy feedback — the copy icon morphs to a checkmark for 1s after a copy.
  const [copied, setCopied] = useState(false);

  // Track whether we're currently dragging (suppress external value sync)
  const isDragging = useRef(false);
  // Last color emitted — committed via `onChangeEnd` on drag pointer-up.
  const lastColorRef = useRef<string>('');
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  trace.fn('ColorPicker:render', { value, inputMode });

  // ─── Sync external value → internal state ────────────────────────────────

  useEffect(() => {
    if (isDragging.current) return;
    const { rgb, alpha: a } = parseColor(value);
    const newHsv = rgbToHsv(rgb);
    setHsv(newHsv);
    setAlpha(a);
  }, [value]);

  // ─── Sync internal state → input text fields ────────────────────────────

  useEffect(() => {
    const rgb = hsvToRgb(hsv);
    setHexInput(rgbToHex(rgb).toUpperCase().replace('#', ''));
    setRgbInputs({ r: String(rgb.r), g: String(rgb.g), b: String(rgb.b) });
    const hsl = rgbToHsl(rgb);
    setHslInputs({
      h: String(Math.round(hsl.h)),
      s: String(Math.round(hsl.s)),
      l: String(Math.round(hsl.l)),
    });
    setAlphaInput(String(Math.round(alpha * 100)));
  }, [hsv, alpha]);

  // ─── Emit color ─────────────────────────────────────────────────────────

  const emitColor = useCallback((newHsv: HSV, newAlpha: number) => {
    const rgb = hsvToRgb(newHsv);
    const color = formatColor(rgb, newAlpha);
    trace.action('color-picker:change', { color });
    lastColorRef.current = color;
    onChange(color);
    // Drag edits commit once on pointer-up (see the pointerup effect below);
    // one-shot edits (hex/rgb/hsl input, eyedropper) commit immediately.
    if (!isDragging.current) onChangeEnd?.(color);
  }, [onChange, onChangeEnd]);

  // ─── Saturation/Brightness Square ────────────────────────────────────────

  const handleSatValDrag = useCallback((x: number, y: number, rect: DOMRect) => {
    isDragging.current = true;
    const s = clamp((x / rect.width) * 100, 0, 100);
    const v = clamp(100 - (y / rect.height) * 100, 0, 100);
    const newHsv = { h: hsv.h, s, v };
    setHsv(newHsv);
    emitColor(newHsv, alpha);
  }, [hsv.h, alpha, emitColor]);

  const satValDrag = usePointerDrag(handleSatValDrag, setCanvasInteracting);

  // ─── Hue Slider ──────────────────────────────────────────────────────────

  const handleHueDrag = useCallback((x: number, _y: number, rect: DOMRect) => {
    isDragging.current = true;
    const h = clamp((x / rect.width) * 360, 0, 360);
    const newHsv = { h, s: hsv.s, v: hsv.v };
    setHsv(newHsv);
    emitColor(newHsv, alpha);
  }, [hsv.s, hsv.v, alpha, emitColor]);

  const hueDrag = usePointerDrag(handleHueDrag, setCanvasInteracting);

  // ─── Alpha Slider ────────────────────────────────────────────────────────

  const handleAlphaDrag = useCallback((x: number, _y: number, rect: DOMRect) => {
    isDragging.current = true;
    const a = clamp(x / rect.width, 0, 1);
    setAlpha(a);
    emitColor(hsv, a);
  }, [hsv, emitColor]);

  const alphaDrag = usePointerDrag(handleAlphaDrag, setCanvasInteracting);

  // Release drag flag on global pointerup — and COMMIT the dragged color
  // once here, so the per-frame `onChange` can stay a cheap live preview.
  useEffect(() => {
    const handleUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      if (lastColorRef.current) onChangeEnd?.(lastColorRef.current);
    };
    window.addEventListener('pointerup', handleUp);
    return () => window.removeEventListener('pointerup', handleUp);
  }, [onChangeEnd]);

  // Clear the pending copy-feedback timer on unmount.
  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, []);

  // ─── Input commit helpers ────────────────────────────────────────────────

  const commitHex = useCallback(() => {
    let h = hexInput.trim().replace(/^#/, '');
    if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(h)) return;
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const rgb = hexToRgb('#' + h);
    const newHsv = rgbToHsv(rgb);
    setHsv(newHsv);
    emitColor(newHsv, alpha);
  }, [hexInput, alpha, emitColor]);

  const commitRgb = useCallback(() => {
    const r = parseInt(rgbInputs.r);
    const g = parseInt(rgbInputs.g);
    const b = parseInt(rgbInputs.b);
    if ([r, g, b].some(isNaN)) return;
    const rgb: RGB = {
      r: clamp(r, 0, 255),
      g: clamp(g, 0, 255),
      b: clamp(b, 0, 255),
    };
    const newHsv = rgbToHsv(rgb);
    setHsv(newHsv);
    emitColor(newHsv, alpha);
  }, [rgbInputs, alpha, emitColor]);

  const commitHsl = useCallback(() => {
    const h = parseInt(hslInputs.h);
    const s = parseInt(hslInputs.s);
    const l = parseInt(hslInputs.l);
    if ([h, s, l].some(isNaN)) return;
    const hsl: HSL = {
      h: clamp(h, 0, 360),
      s: clamp(s, 0, 100),
      l: clamp(l, 0, 100),
    };
    const rgb = hslToRgb(hsl);
    const newHsv = rgbToHsv(rgb);
    setHsv(newHsv);
    emitColor(newHsv, alpha);
  }, [hslInputs, alpha, emitColor]);

  const commitAlpha = useCallback(() => {
    const v = parseInt(alphaInput);
    if (isNaN(v)) return;
    const a = clamp(v, 0, 100) / 100;
    setAlpha(a);
    emitColor(hsv, a);
  }, [alphaInput, hsv, emitColor]);

  const handleInputKeyDown = useCallback((e: React.KeyboardEvent, commitFn: () => void) => {
    if (e.key === 'Enter') {
      commitFn();
      (e.target as HTMLInputElement).blur();
    }
  }, []);

  // ─── Mode cycling ───────────────────────────────────────────────────────

  const cycleMode = useCallback(() => {
    setInputMode(prev => {
      const next = prev === 'hex' ? 'rgb' : prev === 'rgb' ? 'hsl' : 'hex';
      trace.action('color-picker:mode-change', { from: prev, to: next });
      return next;
    });
  }, []);

  // ─── Copy to clipboard ──────────────────────────────────────────────────

  const handleCopy = useCallback(() => {
    // Copy the value in the CURRENTLY SELECTED mode's format — on HSL you
    // get `hsl(...)`, on RGB `rgb(...)`, on HEX `#RRGGBB(AA)`.
    const rgb = hsvToRgb(hsv);
    const a = Math.round(alpha * 100) / 100;
    let text: string;
    if (inputMode === 'rgb') {
      text = alpha >= 1
        ? `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`
        : `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${a})`;
    } else if (inputMode === 'hsl') {
      const hsl = rgbToHsl(rgb);
      const h = Math.round(hsl.h), s = Math.round(hsl.s), l = Math.round(hsl.l);
      text = alpha >= 1
        ? `hsl(${h}, ${s}%, ${l}%)`
        : `hsla(${h}, ${s}%, ${l}%, ${a})`;
    } else {
      // hex — 8-digit when there's transparency, 6-digit otherwise.
      const base = rgbToHex(rgb).toUpperCase();
      text = alpha >= 1
        ? base
        : base + Math.round(alpha * 255).toString(16).padStart(2, '0').toUpperCase();
    }
    navigator.clipboard.writeText(text).then(() => {
      trace.action('color-picker:copy', { text, mode: inputMode });
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1000);
    }).catch((err) => {
      trace.error('color-picker:copy-failed', { error: String(err) });
    });
  }, [hsv, alpha, inputMode]);

  // ─── Eyedropper ──────────────────────────────────────────────────────────

  const handleEyedropper = useCallback(async () => {
    if (typeof window === 'undefined' || !('EyeDropper' in window)) return;
    try {
      const dropper = new (window as any).EyeDropper();
      const result = await dropper.open();
      trace.action('color-picker:eyedropper', { color: result.sRGBHex });
      const rgb = hexToRgb(result.sRGBHex);
      const newHsv = rgbToHsv(rgb);
      setHsv(newHsv);
      setAlpha(1);
      emitColor(newHsv, 1);
    } catch (err) {
      trace.error('color-picker:eyedropper-failed', { error: String(err) });
    }
  }, [emitColor]);

  // ─── Derived values ──────────────────────────────────────────────────────

  const currentRgb = hsvToRgb(hsv);
  const currentHex = rgbToHex(currentRgb);

  // Input styles
  // NO cut on this row (user call 2026-08-20): the hex/alpha inputs and
  // their sibling buttons stay rounded so the row reads as one quiet strip.
  const inputCls = 'h-[var(--control-height-sm)] px-1.5 text-xs bg-[var(--grid-line)] border border-[var(--control-border)] rounded-md text-center outline-none focus:border-[var(--border-focus)] text-[var(--text-primary)]';
  const iconBtnCls = 'h-[var(--control-height-sm)] w-7 flex items-center justify-center bg-[var(--grid-line)] border border-[var(--control-border)] rounded-md cursor-pointer hover:border-[var(--control-border-hover)] text-[var(--text-secondary)]';

  return (
    <div className="space-y-0">
      {/* ── 1. Saturation/Brightness Square ──────────────────────────────── */}
      <div
        ref={satValDrag.ref}
        onPointerDown={satValDrag.onPointerDown}
        className="w-full h-[150px] rounded-md relative cursor-crosshair touch-none"
        style={{ backgroundColor: `hsl(${hsv.h}, 100%, 50%)` }}
      >
        {/* White gradient (left → right) */}
        <div
          className="absolute inset-0 rounded-md"
          style={{ background: 'linear-gradient(to right, #fff, transparent)' }}
        />
        {/* Black gradient (top → bottom) */}
        <div
          className="absolute inset-0 rounded-md"
          style={{ background: 'linear-gradient(to bottom, transparent, #000)' }}
        />
        {/* Handle */}
        <div
          className="w-3 h-3 rounded-full border-2 border-white shadow-md absolute pointer-events-none"
          style={{
            left: `${hsv.s}%`,
            top: `${100 - hsv.v}%`,
            transform: 'translate(-50%, -50%)',
            backgroundColor: currentHex,
          }}
        />
      </div>

      {/* ── 2. Hue Slider ────────────────────────────────────────────────── */}
      <div
        ref={hueDrag.ref}
        onPointerDown={hueDrag.onPointerDown}
        className="w-full h-2 rounded relative cursor-pointer mt-3 touch-none"
        style={{
          background: 'linear-gradient(to right, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)',
        }}
      >
        <div
          className="w-3 h-3 rounded-full border border-white/50 bg-white shadow absolute pointer-events-none"
          style={{
            left: `${(hsv.h / 360) * 100}%`,
            top: '50%',
            transform: 'translate(-50%, -50%)',
          }}
        />
      </div>

      {/* ── 3. Alpha Slider ──────────────────────────────────────────────── */}
      {showAlpha && (
        <div
          ref={alphaDrag.ref}
          onPointerDown={alphaDrag.onPointerDown}
          className="w-full h-2 rounded relative cursor-pointer mt-2 touch-none"
          style={{
            // Checkerboard background for transparency
            backgroundImage: `
              linear-gradient(to right, transparent, ${currentHex}),
              linear-gradient(45deg, #ccc 25%, transparent 25%),
              linear-gradient(-45deg, #ccc 25%, transparent 25%),
              linear-gradient(45deg, transparent 75%, #ccc 75%),
              linear-gradient(-45deg, transparent 75%, #ccc 75%)
            `,
            backgroundSize: '100% 100%, 6px 6px, 6px 6px, 6px 6px, 6px 6px',
            backgroundPosition: '0 0, 0 0, 0 3px, 3px -3px, -3px 0',
          }}
        >
          <div
            className="w-3 h-3 rounded-full border border-white/50 bg-white shadow absolute pointer-events-none"
            style={{
              left: `${alpha * 100}%`,
              top: '50%',
              transform: 'translate(-50%, -50%)',
            }}
          />
        </div>
      )}

      {/* ── 4. Input Row ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1.5 mt-3">
        {/* Mode selector button */}
        <button
          type="button"
          onClick={cycleMode}
          className="h-[var(--control-height-sm)] px-2 text-[10px] font-bold bg-[var(--grid-line)] border border-[var(--control-border)] rounded-md hover:[--cut-border-color:var(--control-border-hover)] cursor-pointer hover:border-[var(--control-border-hover)] text-[var(--text-secondary)] shrink-0 select-none"
        >
          {inputMode.toUpperCase()}
        </button>

        {/* Value inputs */}
        {inputMode === 'hex' && (
          <input
            className={`${inputCls} flex-1 min-w-0`}
            value={hexInput}
            onChange={e => setHexInput(e.target.value)}
            onBlur={commitHex}
            onKeyDown={e => handleInputKeyDown(e, commitHex)}
            spellCheck={false}
          />
        )}

        {inputMode === 'rgb' && (
          <ChannelPill
            values={[rgbInputs.r, rgbInputs.g, rgbInputs.b]}
            onChange={(i, v) => {
              const key = (['r', 'g', 'b'] as const)[i];
              setRgbInputs(p => ({ ...p, [key]: v }));
            }}
            onCommit={commitRgb}
          />
        )}

        {inputMode === 'hsl' && (
          <ChannelPill
            values={[hslInputs.h, hslInputs.s, hslInputs.l]}
            onChange={(i, v) => {
              const key = (['h', 's', 'l'] as const)[i];
              setHslInputs(p => ({ ...p, [key]: v }));
            }}
            onCommit={commitHsl}
          />
        )}

        {/* Copy button — icon cross-fades to a checkmark for 1s on success. */}
        <button
          type="button"
          onClick={handleCopy}
          className={`${iconBtnCls} relative`}
          title={`Copy ${inputMode.toUpperCase()}`}
        >
          <span className={`absolute inset-0 flex items-center justify-center transition-all duration-200 ${copied ? 'opacity-0 scale-50' : 'opacity-100 scale-100'}`}>
            <CopyIcon />
          </span>
          <span className={`absolute inset-0 flex items-center justify-center transition-all duration-200 text-emerald-400 ${copied ? 'opacity-100 scale-100' : 'opacity-0 scale-50'}`}>
            <CheckIcon />
          </span>
        </button>

        {/* Alpha input — the `A` unit sits INSIDE the field as a small
            right-aligned suffix (like the `fr` / `px` chevron labels on
            ToolInput), so it needs no separate label and takes less room. */}
        {showAlpha && (
          <div className="relative shrink-0">
            <input
              className={`${inputCls} w-12 pr-4`}
              value={alphaInput}
              onChange={e => setAlphaInput(e.target.value)}
              onBlur={commitAlpha}
              onKeyDown={e => handleInputKeyDown(e, commitAlpha)}
            />
            <span className="absolute right-1.5 inset-y-0 flex items-center pointer-events-none text-[9px] font-medium text-[var(--text-secondary)] select-none">
              A
            </span>
          </div>
        )}

        {/* Eyedropper */}
        {'EyeDropper' in (typeof window !== 'undefined' ? window : {}) && (
          <button type="button" onClick={handleEyedropper} className={iconBtnCls} title="Pick color from screen">
            <EyedropperIcon />
          </button>
        )}
      </div>

      {/* ── 5. Color preset list + Create button ──────────────────────────── */}
      {(onCreatePreset || (colorPresets && colorPresets.length > 0)) && (
        <div className="mt-3 border-t border-[var(--border-light)] pt-2">
          {/* Create new preset row */}
          {onCreatePreset && (
            <button
              type="button"
              onClick={() => {
                trace.action('color-picker:create-preset-click', { color: currentHex });
                onCreatePreset(currentHex);
              }}
              className="w-full flex items-center justify-between px-1 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] cut-corners cursor-pointer transition-colors"
            >
              <span>Create new color preset</span>
              <PlusIcon />
            </button>
          )}

          {/* Preset list — name on left, swatch on right, Edit on hover */}
          {colorPresets && colorPresets.length > 0 && (
            <div className="flex flex-col max-h-[200px] overflow-y-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
              {colorPresets.map(preset => {
                const displayName = preset.label || preset.name.replace(/^color-/, '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                const isActive = activePresetName === preset.name;
                return (
                  <div
                    key={preset.name}
                    className={`group flex items-center gap-2 px-1 py-1.5 cut-corners cursor-pointer transition-colors ${
                      isActive ? 'bg-[var(--bg-hover)]' : 'hover:bg-[var(--bg-hover)]'
                    }`}
                    onClick={() => {
                      if (onApplyPreset) {
                        onApplyPreset(`var(--${preset.name})`);
                      } else {
                        onChange(preset.value);
                      }
                      trace.action('color-picker:apply-preset', { name: preset.name, value: preset.value });
                    }}
                  >
                    <span className={`flex-1 text-xs font-medium truncate ${isActive ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>{displayName}</span>
                    {onEditPreset && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onEditPreset(preset.name);
                          trace.action('color-picker:edit-preset', { name: preset.name });
                        }}
                        className="opacity-0 group-hover:opacity-100 text-[10px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-[var(--grid-line)] border border-[var(--control-border)] [--cut-border-color:var(--control-border)] cut-corners cut-border px-2 py-0.5 transition-all cursor-pointer"
                      >
                        Edit
                      </button>
                    )}
                    <ColorSwatch style={{ backgroundColor: preset.value }} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
