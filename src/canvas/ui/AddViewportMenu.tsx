// AddViewportMenu.tsx — Dropdown menu for adding viewport breakpoints.
// Ported from old builder's AddViewportMenu with identical design.
// Shows device presets (desktop/tablet/mobile) + custom breakpoint option.

import { useState, useRef, useLayoutEffect, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { DesktopViewportIcon, TabletViewportIcon, MobileViewportIcon } from '@/shared/icons';
import { trace } from '@/shared/debug-trace';
import { useSuppressCanvasHover, stopHoverProbe } from './useSuppressCanvasHover';

// ─── Device Presets ─────────────────────────────────────────────────────────

const DEVICE_PRESETS: Array<{
  id: string;
  label: string;
  width: number;
  category: 'desktop' | 'tablet' | 'mobile';
}> = [
  // Desktops
  { id: 'ultra-wide', label: 'Ultra Wide', width: 2560, category: 'desktop' },
  { id: 'full-hd', label: 'Full HD', width: 1920, category: 'desktop' },
  { id: 'laptop-large', label: 'Laptop L', width: 1440, category: 'desktop' },
  { id: 'laptop', label: 'Laptop', width: 1366, category: 'desktop' },
  { id: 'laptop-small', label: 'Laptop S', width: 1280, category: 'desktop' },
  // Tablets
  { id: 'ipad-pro-12', label: 'iPad Pro 12.9"', width: 1024, category: 'tablet' },
  { id: 'surface-pro', label: 'Surface Pro', width: 912, category: 'tablet' },
  { id: 'ipad-air', label: 'iPad Air', width: 820, category: 'tablet' },
  { id: 'ipad-mini', label: 'iPad Mini', width: 768, category: 'tablet' },
  // Phones
  { id: 'iphone-15-pro-max', label: 'iPhone 15 Pro Max', width: 430, category: 'mobile' },
  { id: 'iphone-15', label: 'iPhone 14/15', width: 393, category: 'mobile' },
  { id: 'iphone-se', label: 'iPhone SE', width: 375, category: 'mobile' },
  { id: 'pixel-7', label: 'Pixel 7', width: 412, category: 'mobile' },
  { id: 'galaxy-s23', label: 'Galaxy S23', width: 360, category: 'mobile' },
  { id: 'galaxy-fold', label: 'Galaxy Fold', width: 280, category: 'mobile' },
];

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AddViewportMenuState {
  show: boolean;
  sourceVpId: string;
  x: number;
  y: number;
}

interface Props {
  menu: AddViewportMenuState;
  existingVpIds: string[];
  onAdd: (vpId: string, label: string, width: number) => void;
  onClose: () => void;
}

// ─── Icon Picker ────────────────────────────────────────────────────────────

function getCategoryIcon(category: string) {
  switch (category) {
    case 'desktop': return DesktopViewportIcon;
    case 'tablet': return TabletViewportIcon;
    case 'mobile': return MobileViewportIcon;
    default: return DesktopViewportIcon;
  }
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function AddViewportMenu({ menu, existingVpIds, onAdd, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  // No hover hit-testing behind the open popup (and clear the lingering one).
  useSuppressCanvasHover(true);
  const [isVisible, setIsVisible] = useState(false);
  const [menuStyle, setMenuStyle] = useState({ left: -9999, top: -9999 });
  const [showCustom, setShowCustom] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customWidth, setCustomWidth] = useState('');

  trace.fn('AddViewportMenu.render', { show: menu.show, sourceVpId: menu.sourceVpId });

  // Position menu, clamped to viewport
  useLayoutEffect(() => {
    if (!menu.show) {
      setIsVisible(false);
      setShowCustom(false);
      return;
    }

    // Position immediately using the click coordinates, clamp to window edges
    let left = menu.x;
    let top = menu.y;
    // Estimate menu size (208px wide, ~400px tall max) for initial clamp
    if (left + 208 > window.innerWidth) left = window.innerWidth - 208 - 16;
    if (top + 400 > window.innerHeight) top = window.innerHeight - 400 - 16;
    left = Math.max(16, left);
    top = Math.max(16, top);

    setMenuStyle({ left, top });
    // Show immediately — no RAF delay
    setIsVisible(true);
  }, [menu.show, menu.x, menu.y]);

  // Close on Escape
  useEffect(() => {
    if (!menu.show) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (showCustom) {
          setShowCustom(false);
          setCustomName('');
          setCustomWidth('');
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu.show, showCustom, onClose]);

  const handleAddPreset = useCallback((preset: { id: string; label: string; width: number }) => {
    if (existingVpIds.includes(preset.id)) return;
    trace.action('add-viewport:preset', { id: preset.id, width: preset.width });
    onAdd(preset.id, preset.label, preset.width);
    onClose();
  }, [existingVpIds, onAdd, onClose]);

  const handleAddCustom = useCallback(() => {
    const name = customName.trim();
    const width = parseInt(customWidth, 10);
    if (!name || !width || width < 100 || width > 5000) {
      trace.action('add-viewport:custom-invalid', { name, width, reason: !name ? 'empty name' : 'invalid width' });
      return;
    }
    const vpId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (existingVpIds.includes(vpId)) {
      trace.action('add-viewport:custom-duplicate', { vpId });
      return;
    }
    trace.action('add-viewport:custom', { id: vpId, width });
    onAdd(vpId, name, width);
    onClose();
  }, [customName, customWidth, existingVpIds, onAdd, onClose]);

  if (!menu.show) return null;

  const existingSet = new Set(existingVpIds);
  const available = DEVICE_PRESETS.filter(p => !existingSet.has(p.id));
  const desktopPresets = available.filter(p => p.category === 'desktop');
  const tabletPresets = available.filter(p => p.category === 'tablet');
  const mobilePresets = available.filter(p => p.category === 'mobile');

  const renderSection = (label: string, presets: typeof DEVICE_PRESETS, category: string) => {
    if (presets.length === 0) return null;
    const Icon = getCategoryIcon(category);
    return (
      <>
        <div style={{ padding: '8px 12px 4px', fontSize: 10, fontWeight: 500, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {label}
        </div>
        {presets.map(preset => (
          <div
            key={preset.id}
            onClick={() => handleAddPreset(preset)}
            className="vp-add-item"
            style={itemStyle}
          >
            <span style={{ color: 'var(--text-secondary)' }}><Icon size={11} /></span>
            <span style={{ fontSize: 12, color: 'var(--text-primary)', flex: 1 }}>{preset.label}</span>
            <span style={{ fontSize: 10, color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>{preset.width}</span>
          </div>
        ))}
      </>
    );
  };

  return createPortal(
    <>
      {/* Invisible full-screen click-catcher → context-menu behavior: a click
          anywhere outside the panel ONLY closes the menu, it does NOT also
          select / deselect a canvas node behind it. React PORTAL events bubble
          through the React TREE (not the DOM), so without swallowing the press
          here it reaches the Canvas's onMouseDown and hit-tests the node below.
          CRITICAL: do NOT close on mousedown — that unmounts this backdrop
          mid-gesture and the trailing mouseup+click fall through to the canvas.
          Swallow the whole press (preventDefault + stopPropagation, stays
          mounted) and close on the COMPLETED click / contextmenu. Mirrors the
          design-system DropdownMenu backdrop. */}
      <div
        style={{ position: 'fixed', inset: 0, background: 'transparent', zIndex: 9998 }}
        {...stopHoverProbe}
        onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onMouseUp={(e) => { e.stopPropagation(); }}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); }}
      />
      {/* Menu */}
      <div
        {...stopHoverProbe}
        ref={menuRef}
        style={{
          position: 'fixed',
          width: 208,
          backgroundColor: 'var(--dropdown-bg)',
          borderRadius: 'var(--radius-md)',
          boxShadow: 'var(--shadow-lg)',
          zIndex: 9999,   // above the properties panel (z-5000) — was 1000, hid behind it
          border: '1px solid var(--border-light)',
          left: menuStyle.left,
          top: menuStyle.top,
          opacity: isVisible ? 1 : 0,
          transition: 'opacity 0.15s ease',
        }}
        // Swallow the whole press so a click on a ROW only runs the row's
        // handler — it must NOT bubble (through the React portal tree) to the
        // Canvas onMouseDown and select the node behind the menu. stopPropagation
        // only (no preventDefault) so inputs in the Custom form still focus.
        onMouseDown={e => e.stopPropagation()}
        onMouseUp={e => e.stopPropagation()}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.1)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {showCustom && (
              <button
                onClick={() => { setShowCustom(false); setCustomName(''); setCustomWidth(''); }}
                style={headerBtnStyle}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
              </button>
            )}
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>
              {showCustom ? 'Custom Breakpoint' : 'Add Breakpoint'}
            </span>
          </div>
          <button onClick={onClose} style={headerBtnStyle}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>

        {!showCustom ? (
          <div className="scrollbar-hide" style={{ padding: '4px 0', maxHeight: 360, overflowY: 'auto' }}>
            {/* Custom option at top */}
            <div
              onClick={() => setShowCustom(true)}
              className="vp-add-item"
              style={itemStyle}
            >
              <span style={{ color: 'var(--text-secondary)', fontSize: 11, lineHeight: 1 }}>+</span>
              <span style={{ fontSize: 12, color: 'var(--text-primary)', flex: 1 }}>Custom...</span>
            </div>

            {/* Quick-add Tablet & Mobile if not existing */}
            {(!existingSet.has('tablet') || !existingSet.has('mobile')) && (
              <>
                <div style={dividerStyle} />
                {!existingSet.has('tablet') && (
                  <div
                    onClick={() => handleAddPreset({ id: 'tablet', label: 'Tablet', width: 768 })}
                    className="vp-add-item"
                    style={itemStyle}
                  >
                    <span style={{ color: 'var(--text-secondary)' }}><TabletViewportIcon size={11} /></span>
                    <span style={{ fontSize: 12, color: 'var(--text-primary)', flex: 1 }}>Tablet</span>
                    <span style={{ fontSize: 10, color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>768</span>
                  </div>
                )}
                {!existingSet.has('mobile') && (
                  <div
                    onClick={() => handleAddPreset({ id: 'mobile', label: 'Mobile', width: 375 })}
                    className="vp-add-item"
                    style={itemStyle}
                  >
                    <span style={{ color: 'var(--text-secondary)' }}><MobileViewportIcon size={11} /></span>
                    <span style={{ fontSize: 12, color: 'var(--text-primary)', flex: 1 }}>Mobile</span>
                    <span style={{ fontSize: 10, color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>375</span>
                  </div>
                )}
              </>
            )}

            <div style={dividerStyle} />
            {renderSection('Desktop', desktopPresets, 'desktop')}
            {renderSection('Tablet', tabletPresets, 'tablet')}
            {renderSection('Mobile', mobilePresets, 'mobile')}
          </div>
        ) : (
          /* Custom breakpoint form */
          <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input
              value={customName}
              onChange={e => setCustomName(e.target.value)}
              placeholder="Name (e.g. Wide Screen)"
              autoFocus
              onKeyDown={e => { if (e.key === 'Enter') handleAddCustom(); }}
              className={`${INPUT_CLASS} w-full`}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                value={customWidth}
                onChange={e => setCustomWidth(e.target.value)}
                placeholder="Width"
                type="number"
                onKeyDown={e => { if (e.key === 'Enter') handleAddCustom(); }}
                className={`${INPUT_CLASS} flex-1`}
              />
              <span style={{ fontSize: 10, color: 'var(--text-tertiary)', flexShrink: 0 }}>px</span>
            </div>
            <button
              onClick={handleAddCustom}
              disabled={!customName.trim() || !customWidth}
              className="w-full h-8 text-xs font-medium text-[var(--accent-fg)] cut-corners hover:brightness-110 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:brightness-100"
              style={{ backgroundColor: 'var(--accent)' }}
            >
              Add Breakpoint
            </button>
          </div>
        )}
      </div>
    </>,
    document.body,
  );
}

// ─── Shared Styles ──────────────────────────────────────────────────────────

const itemStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10,
  margin: '0 6px', padding: '6px 8px', cursor: 'pointer',
  borderRadius: 'var(--radius-sm)',
};

const dividerStyle: React.CSSProperties = {
  height: 1, backgroundColor: 'rgba(255,255,255,0.1)', margin: '4px 8px',
};

const headerBtnStyle: React.CSSProperties = {
  padding: 2, background: 'none', border: 'none', cursor: 'pointer',
  borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};

// The app's standard text-input style (matches VariableModal + tool inputs).
// No width utility here — the Name input adds `w-full`, the Width input `flex-1`.
const INPUT_CLASS =
  'h-8 px-3 text-xs bg-[var(--grid-line)] text-[var(--text-primary)] border border-[var(--border-light)] cut-corners cut-border [--cut-border-color:var(--border-light)] hover:[--cut-border-color:var(--control-border)] focus:[--cut-border-color:var(--border-focus)] hover:border-[var(--control-border)] focus:border-[var(--border-focus)] focus:outline-none transition-colors';
