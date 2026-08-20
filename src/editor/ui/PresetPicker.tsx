// PresetPicker.tsx — Popup for selecting design preset tokens.
// Shows filtered tokens by property type. Click to apply var(--token-name).
// Uses portal positioning near the anchor element.

import { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { PresetToken } from '@/shared/types';
import { trace } from '@/shared/debug-trace';

// ─── Category → property matching ────────────────────────────────────────────

const COLOR_PROPS = new Set([
  'backgroundColor', 'color', 'borderColor', 'borderTopColor', 'borderRightColor',
  'borderBottomColor', 'borderLeftColor', 'textDecorationColor', 'outlineColor',
  'caretColor', 'accentColor', 'fill', 'stroke', 'stopColor', 'floodColor',
  'columnRuleColor',
]);

const TYPOGRAPHY_PROPS = new Set([
  'fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'lineHeight',
  'wordSpacing', 'textIndent',
]);

const SPACING_PROPS = new Set([
  'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'gap', 'rowGap', 'columnGap', 'top', 'left', 'right', 'bottom',
  'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
  'inset', 'insetBlock', 'insetInline',
]);

const RADIUS_PROPS = new Set([
  'borderRadius', 'borderTopLeftRadius', 'borderTopRightRadius',
  'borderBottomLeftRadius', 'borderBottomRightRadius',
]);

const SHADOW_PROPS = new Set([
  'boxShadow', 'textShadow',
]);

function getMatchingCategories(property: string): Set<PresetToken['category']> {
  const cats = new Set<PresetToken['category']>();
  if (COLOR_PROPS.has(property)) cats.add('color');
  if (TYPOGRAPHY_PROPS.has(property)) cats.add('typography');
  if (SPACING_PROPS.has(property)) cats.add('spacing');
  if (RADIUS_PROPS.has(property)) cats.add('radius');
  if (SHADOW_PROPS.has(property)) cats.add('shadow');
  // 'other' category always matches
  cats.add('other');
  return cats;
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface PresetPickerProps {
  property: string;
  tokens: PresetToken[];
  onSelect: (tokenName: string) => void;
  isOpen: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function PresetPicker({ property, tokens, onSelect, isOpen, onClose, anchorRef }: PresetPickerProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  // Filter tokens by property compatibility
  const matchingCategories = useMemo(() => getMatchingCategories(property), [property]);

  const filteredTokens = useMemo(() => {
    return tokens.filter(t => matchingCategories.has(t.category));
  }, [tokens, matchingCategories]);

  // Position popup near the anchor
  const recalcPosition = useCallback(() => {
    if (!anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const menuWidth = 220;
    const padding = 16;

    let x: number;
    if (rect.left - menuWidth - 8 > padding) {
      x = rect.left - menuWidth - 8;
    } else {
      x = rect.right + 8;
    }

    let y = rect.top;
    const menuHeight = Math.min(filteredTokens.length * 36 + 12, 320);
    if (y + menuHeight > window.innerHeight - padding) {
      y = Math.max(padding, window.innerHeight - menuHeight - padding);
    }

    setPos({ x, y });
  }, [anchorRef, filteredTokens.length]);

  useEffect(() => {
    if (!isOpen) return;
    recalcPosition();
    trace.action('preset-picker:open', { property, tokenCount: filteredTokens.length });
  }, [isOpen, recalcPosition, property, filteredTokens.length]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSelect = (tokenName: string) => {
    onSelect(tokenName);
    onClose();
    trace.action('preset-picker:select', { property, tokenName });
  };

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50"
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      />

      {/* Popup */}
      <div
        ref={popupRef}
        className="fixed bg-[var(--dropdown-bg)] shadow-[var(--shadow-lg)] cut-corners cut-lg cut-border [--cut-border-color:var(--border-light)] py-1.5 z-51 min-w-[220px] max-h-[320px] overflow-y-auto border border-[var(--border-light)]"
        style={{ left: pos.x, top: pos.y }}
      >
        {filteredTokens.length === 0 ? (
          <div className="px-3 py-2 text-xs text-[var(--text-disabled)]">
            No matching presets
          </div>
        ) : (
          filteredTokens.map((token) => (
            <button
              key={token.name}
              onClick={() => handleSelect(token.name)}
              className="group flex items-center gap-2 mx-1.5 px-2.5 py-1.5 cut-corners w-[calc(100%-12px)] text-left cursor-pointer hover:bg-[var(--accent)] transition-colors"
            >
              {/* Color swatch for color tokens */}
              {token.category === 'color' && (
                <span
                  className="w-4 h-4 rounded-[3px] border border-white/15 flex-shrink-0"
                  style={{ backgroundColor: token.value }}
                />
              )}

              {/* Token info */}
              <span className="flex flex-col min-w-0">
                <span className="text-xs font-medium text-[var(--text-primary)] group-hover:text-[var(--accent-fg)] truncate">
                  {token.label || token.name}
                </span>
                <span className="text-[10px] text-[var(--text-disabled)] group-hover:text-[var(--accent-fg)]/60 truncate">
                  {token.value}
                </span>
              </span>
            </button>
          ))
        )}
      </div>
    </>,
    document.body,
  );
}
