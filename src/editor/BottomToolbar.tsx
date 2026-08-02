// BottomToolbar.tsx — Floating bottom toolbar pill with tool modes, zoom, search, theme, comments.
// Matches old builder styling exactly: same padding, gaps, button sizes, icons, dropdowns.

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useClickOutside } from './hooks/useClickOutside';
import { CLOUD_ENABLED } from '@/shared/cloud-flag';
import { motion } from 'framer-motion';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { toolModeAtom, isShapeMode, isLayoutMode, type ToolMode } from '@/code/stores/tool-store';
import { transformManager, zoomIn, zoomOut, zoomTo100, zoomToFit, zoomToFitSelection } from '@/canvas/transform';
import { getContentRoot } from '@/canvas/node-ops';
import { selectedNodeAtom } from '@/code/stores/store';
import { activeFilePathAtom, isIconSetFilePath } from '@/code/project/active-file-store';
import { i18nConfigAtom, activeLocaleAtom, isDefaultLocaleAtom } from '@/code/stores/locale-store';
import { commentModeActiveAtom } from '@/code/stores/comment-store';
import {
  CursorIcon, FrameToolbarIcon, TextToolbarIcon, HandToolbarIcon,
  ShapeSquareIcon, ShapeCircleIcon, ShapeTriangleIcon, ShapePathIcon,
  LayoutRowsIcon, LayoutColumnsIcon, LayoutGridIcon,
  ThemeSunIcon, ThemeMoonIcon, SearchIcon, CommentBubbleIcon,
  SketchPencilIcon,
} from '@/shared/icons';
import { usePaletteToggle } from '@/editor/command-palette/CommandPalette';
import { trace } from '@/shared/debug-trace';
import { useIsViewer, useIsOffline } from '@/code/stores/viewer-mode-store';

// ─── Chevron & Check icons ─────────────────────────────────────────────────

const ChevronDownSvg = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

const CheckSvg = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

// ─── Shared sub-components ──────────────────────────────────────────────────

function Separator() {
  return <div className="w-px h-[26px] bg-[var(--border-light)] mx-1 shrink-0" />;
}

function ShortcutHint({ text }: { text: string }) {
  return <span className="text-[11px] text-[var(--text-tertiary)] ml-auto pl-4">{text}</span>;
}

function MenuItem({ label, shortcut, icon, active, onClick, disabled }: {
  label: string; shortcut?: string; icon?: React.ReactNode; active?: boolean;
  onClick: () => void; disabled?: boolean;
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      className={`flex items-center w-full px-3 py-1.5 text-xs rounded-[var(--radius-sm)] transition-colors gap-2 bg-transparent ${
        disabled
          ? 'text-[var(--text-disabled)] cursor-not-allowed opacity-50'
          : 'text-[var(--text-primary)] hover:bg-[var(--btn-secondary-bg)] cursor-pointer'
      }`}
      style={{ border: 'none', fontFamily: 'Inter, system-ui, sans-serif', textAlign: 'left' }}
    >
      <span className="w-4 h-4 flex items-center justify-center shrink-0">
        {active ? <CheckSvg /> : icon ?? null}
      </span>
      <span>{label}</span>
      {shortcut && <ShortcutHint text={shortcut} />}
    </button>
  );
}

function DropdownContainer({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 min-w-[180px] bg-[var(--bg-surface)] border border-[var(--border-light)] rounded-[var(--radius-md)] shadow-lg p-2 z-[100]">
      {children}
    </div>
  );
}

function DropdownDivider() {
  return <div className="h-px bg-[var(--border-light)] my-1" />;
}

// ─── Split Button (icon + chevron) ──────────────────────────────────────────

function SplitButton({ active, icon, onClick, onChevronClick, title }: {
  active: boolean; icon: React.ReactNode; onClick: () => void;
  onChevronClick: () => void; title: string;
}) {
  return (
    <div className="flex items-center">
      <button
        onClick={onClick}
        title={title}
        className={`flex items-center justify-center px-1.5 h-[32px] rounded-[var(--radius-sm)] transition-colors ${
          active
            ? 'bg-[var(--accent)] text-[var(--accent-fg)] hover:brightness-110'
            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
        }`}
        style={{ border: 'none', cursor: 'pointer' }}
      >
        {icon}
      </button>
      <button
        onClick={onChevronClick}
        className={`flex items-center justify-center w-[12px] h-[32px] transition-colors ${
          active
            ? 'text-white/70 hover:text-white'
            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] rounded-[var(--radius-sm)]'
        }`}
        style={{ border: 'none', cursor: 'pointer', backgroundColor: 'transparent' }}
      >
        <ChevronDownSvg />
      </button>
    </div>
  );
}

// ─── Tool Button (simple) ───────────────────────────────────────────────────

function ToolButton({ active, onClick, title, children, dataTutorial }: {
  active?: boolean; onClick: () => void; title: string; children: React.ReactNode;
  dataTutorial?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      data-tutorial={dataTutorial}
      className={`flex items-center justify-center px-1.5 h-[32px] rounded-[var(--radius-sm)] transition-colors ${
        active
          ? 'bg-[var(--accent)] text-[var(--accent-fg)] hover:brightness-110'
          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
      }`}
      style={{ border: 'none', cursor: 'pointer' }}
    >
      {children}
    </button>
  );
}

// ─── Cursor Dropdown ────────────────────────────────────────────────────────

function CursorDropdown({ toolMode, commentModeActive, onSelect }: {
  toolMode: ToolMode; commentModeActive: boolean; onSelect: (m: ToolMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Comment mode forces toolMode to 'select' under the hood, but it's a
  // separate tool from the user's POV — so the cursor button must read
  // as inactive while comment mode owns the canvas.
  const isActive = (toolMode === 'select' || toolMode === 'hand') && !commentModeActive;

  useClickOutside(ref, open, () => setOpen(false));

  const currentIcon = toolMode === 'hand'
    ? <HandToolbarIcon className="w-[22px] h-[22px]" />
    : <CursorIcon className="w-[22px] h-[22px] translate-y-0.5" />;

  return (
    <div className="relative" ref={ref}>
      <SplitButton
        active={isActive || open}
        icon={currentIcon}
        onClick={() => onSelect(toolMode === 'hand' ? 'hand' : 'select')}
        onChevronClick={() => setOpen(!open)}
        title="Select (V) / Hand (H)"
      />
      {open && (
        <DropdownContainer>
          <MenuItem label="Move" shortcut="V" active={toolMode === 'select'} onClick={() => { onSelect('select'); setOpen(false); }} />
          <MenuItem label="Hand tool" shortcut="H" active={toolMode === 'hand'} icon={<div className="w-4 h-4" />} onClick={() => { onSelect('hand'); setOpen(false); }} />
        </DropdownContainer>
      )}
    </div>
  );
}

// ─── Shape Dropdown ─────────────────────────────────────────────────────────

// `onSketch` activates the freehand sketch tool — sketches live alongside
// the vector shapes (they bundle into a Vector Set).
function ShapeDropdown({ active, sketchActive, onSelect, onSketch }: {
  active: boolean; sketchActive: boolean; onSelect: (shape: string) => void; onSketch: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [currentShape, setCurrentShape] = useState('square');
  const ref = useRef<HTMLDivElement>(null);

  useClickOutside(ref, open, () => setOpen(false));

  const shapeIcons: Record<string, React.ReactNode> = {
    square: <ShapeSquareIcon className="w-[22px] h-[22px]" size={22} />,
    circle: <ShapeCircleIcon className="w-[22px] h-[22px]" size={22} />,
    triangle: <ShapeTriangleIcon className="w-[22px] h-[22px]" size={22} />,
    path: <ShapePathIcon className="w-[22px] h-[22px]" size={22} />,
    sketch: <SketchPencilIcon className="w-[22px] h-[22px]" size={22} />,
  };

  // The trigger re-activates the last-picked tool — `sketch` routes to the
  // freehand tool, every other value to the matching vector shape.
  const activate = (pick: string) => { if (pick === 'sketch') onSketch(); else onSelect(pick); };

  return (
    <div className="relative" ref={ref} data-tutorial="shape-tool">
      <SplitButton
        active={active || sketchActive || open}
        icon={shapeIcons[currentShape]}
        onClick={() => { activate(currentShape); }}
        onChevronClick={() => setOpen(!open)}
        title="Shapes"
      />
      {open && (
        <DropdownContainer>
          <MenuItem label="Square" shortcut="R" active={active && currentShape === 'square'} icon={<ShapeSquareIcon className="w-4 h-4" size={16} />} onClick={() => { setCurrentShape('square'); onSelect('square'); setOpen(false); }} />
          <MenuItem label="Circle" shortcut="O" active={active && currentShape === 'circle'} icon={<ShapeCircleIcon className="w-4 h-4" size={16} />} onClick={() => { setCurrentShape('circle'); onSelect('circle'); setOpen(false); }} />
          <MenuItem label="Triangle" shortcut="Shift+T" active={active && currentShape === 'triangle'} icon={<ShapeTriangleIcon className="w-4 h-4" size={16} />} onClick={() => { setCurrentShape('triangle'); onSelect('triangle'); setOpen(false); }} />
          <MenuItem label="Path" shortcut="P" active={active && currentShape === 'path'} icon={<ShapePathIcon className="w-4 h-4" size={16} />} onClick={() => { setCurrentShape('path'); onSelect('path'); setOpen(false); }} />
          <MenuItem label="Sketch" shortcut="K" active={sketchActive} icon={<SketchPencilIcon className="w-4 h-4" size={16} />} onClick={() => { setCurrentShape('sketch'); onSketch(); setOpen(false); }} />
        </DropdownContainer>
      )}
    </div>
  );
}

// ─── Layout Dropdown ────────────────────────────────────────────────────────

function LayoutDropdown({ toolMode, onSelect }: { toolMode: ToolMode; onSelect: (layout: string) => void }) {
  const [open, setOpen] = useState(false);
  // Last layout the user chose — what the split button activates by default.
  // Synced from toolMode so re-selecting the dropdown shows the latest pick.
  const [lastLayout, setLastLayout] = useState<'rows' | 'columns' | 'grids'>('rows');
  const ref = useRef<HTMLDivElement>(null);

  // Keep lastLayout in sync with toolMode (e.g. when activated via shortcut)
  useEffect(() => {
    if (toolMode === 'layout-rows') setLastLayout('rows');
    else if (toolMode === 'layout-columns') setLastLayout('columns');
    else if (toolMode === 'layout-grids') setLastLayout('grids');
  }, [toolMode]);

  useClickOutside(ref, open, () => setOpen(false));

  const active = isLayoutMode(toolMode);
  const currentLayout: 'rows' | 'columns' | 'grids' = active
    ? (toolMode === 'layout-rows' ? 'rows' : toolMode === 'layout-columns' ? 'columns' : 'grids')
    : lastLayout;

  const layoutIcons: Record<string, React.ReactNode> = {
    rows: <LayoutRowsIcon className="w-[22px] h-[22px]" size={22} />,
    columns: <LayoutColumnsIcon className="w-[22px] h-[22px]" size={22} />,
    grids: <LayoutGridIcon className="w-[22px] h-[22px]" size={22} />,
  };

  return (
    <div className="relative" ref={ref}>
      <SplitButton
        active={active || open}
        icon={layoutIcons[currentLayout]}
        onClick={() => { onSelect(currentLayout); }}
        onChevronClick={() => setOpen(!open)}
        title="Layout"
      />
      {open && (
        <DropdownContainer>
          <MenuItem label="Rows" shortcut="Shift+R" active={active && currentLayout === 'rows'} icon={<LayoutRowsIcon className="w-4 h-4" size={16} />} onClick={() => { setLastLayout('rows'); onSelect('rows'); setOpen(false); }} />
          <MenuItem label="Columns" shortcut="Shift+C" active={active && currentLayout === 'columns'} icon={<LayoutColumnsIcon className="w-4 h-4" size={16} />} onClick={() => { setLastLayout('columns'); onSelect('columns'); setOpen(false); }} />
          <MenuItem label="Grids" shortcut="Shift+G" active={active && currentLayout === 'grids'} icon={<LayoutGridIcon className="w-4 h-4" size={16} />} onClick={() => { setLastLayout('grids'); onSelect('grids'); setOpen(false); }} />
        </DropdownContainer>
      )}
    </div>
  );
}

// ─── Zoom Dropdown ──────────────────────────────────────────────────────────

function ZoomDropdown({ selectedId }: { selectedId: string | null }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Zoom % lives HERE (not on the toolbar root) and is THROTTLED: the old
  // per-tick setState on the parent re-rendered the ENTIRE toolbar on every
  // camera frame — that invalidated the toolbar's whole compositor layer
  // per tick, and during a big zoom-out (GPU busy re-rastering the canvas)
  // its re-raster starved and the toolbar visibly glitched (live find
  // 2026-07-19; the panels, which don't re-render during zoom, stayed
  // stable with layer isolation alone). Scoped here + throttled at 150ms
  // (leading + trailing), only this small chip repaints a few times per
  // second and the toolbar body never invalidates mid-gesture.
  const [zoomPercent, setZoomPercent] = useState(() => Math.round(transformManager.getTransform().scale * 100));
  useEffect(() => {
    // TRAILING-ONLY debounce — the chip does NOT update during a camera
    // gesture at all. Even the earlier 150ms throttle invalidated the chip's
    // layer a few times per second mid-gesture, and rasterisation for ALL
    // processes shares ONE GPU process — under a violent zoom's raster
    // flood each of those repaints starved and the chip showed as a grey
    // box with no number (renderer-process isolation can't fix GPU-process
    // contention). Zero invalidations while ticks stream; one update lands
    // ~180ms after the LAST tick with the exact final value.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const apply = () => setZoomPercent(Math.round(transformManager.getTransform().scale * 100));
    const update = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; apply(); }, 180);
    };
    const unsub = transformManager.subscribe(update);
    return () => { unsub(); if (timer) clearTimeout(timer); };
  }, []);

  useClickOutside(ref, open, () => setOpen(false));

  const getContentEl = () => getContentRoot();

  return (
    <div className="relative flex items-center" ref={ref} style={{ willChange: 'transform', isolation: 'isolate' }}>
      {/* Zoom % button */}
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center justify-center h-[32px] min-w-[50px] px-2.5 rounded-lg text-xs font-medium transition-all ${
          open
            ? 'bg-[var(--accent)] text-[var(--accent-fg)] border border-[var(--accent)]'
            : 'bg-[var(--grid-line)] border border-[var(--control-border)] hover:border-[var(--border-focus)] text-[var(--text-secondary)]'
        }`}
        style={{ cursor: 'pointer', fontFamily: 'Inter, system-ui, sans-serif' }}
      >
        {zoomPercent}%
      </button>

      {open && (
        <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 min-w-[200px] bg-[var(--bg-surface)] border border-[var(--border-light)] rounded-[var(--radius-md)] shadow-lg p-2 z-[100]">
          <MenuItem label="Fit" shortcut="Shift+1" onClick={() => { const el = getContentEl(); if (el) zoomToFit(el); setOpen(false); }} />
          <MenuItem label="Fit Selection" shortcut="Shift+2" onClick={() => { const el = getContentEl(); if (el) zoomToFitSelection(el, selectedId ? [selectedId] : []); setOpen(false); }} />
          <MenuItem label="Zoom 100%" shortcut="Shift+3" onClick={() => { zoomTo100(); setOpen(false); }} />
          <DropdownDivider />
          <MenuItem label="Zoom In" shortcut="Ctrl+Plus" onClick={() => { zoomIn(); setOpen(false); }} />
          <MenuItem label="Zoom Out" shortcut="Ctrl+Minus" onClick={() => { zoomOut(); setOpen(false); }} />
        </div>
      )}
    </div>
  );
}

// ─── Locale Dropdown ────────────────────────────────────────────────────────

function LocaleDropdown() {
  const [open, setOpen] = useState(false);
  const config = useAtomValue(i18nConfigAtom);
  const [activeLocale, setActiveLocale] = useAtom(activeLocaleAtom);
  const isDefault = useAtomValue(isDefaultLocaleAtom);
  const ref = useRef<HTMLDivElement>(null);

  useClickOutside(ref, open, () => setOpen(false));

  // Map locale configs to display items with flag emojis
  const FLAG_MAP: Record<string, string> = { en: '🇺🇸', fr: '🇫🇷', es: '🇪🇸', de: '🇩🇪', it: '🇮🇹', pt: '🇧🇷', ja: '🇯🇵', ko: '🇰🇷', zh: '🇨🇳', ar: '🇸🇦', ru: '🇷🇺', nl: '🇳🇱', sv: '🇸🇪', pl: '🇵🇱', tr: '🇹🇷', hi: '🇮🇳' };
  const languages = config.locales.map(l => ({
    code: l.code,
    label: l.label,
    flag: FLAG_MAP[l.code] || '🌐',
  }));

  const current = languages.find(l => l.code === activeLocale) ?? languages[0];

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        title="Language"
        className={`flex items-center gap-1.5 px-2.5 h-[32px] rounded-lg transition-all ${
          !isDefault
            ? 'bg-orange-500/20 text-orange-400 border border-orange-500/40'
            : open
              ? 'bg-[var(--accent)] text-[var(--accent-fg)] border border-[var(--accent)]'
              : 'bg-[var(--grid-line)] border border-[var(--control-border)] hover:border-[var(--border-focus)] text-[var(--text-secondary)]'
        }`}
        style={{ cursor: 'pointer', fontFamily: 'Inter, system-ui, sans-serif' }}
      >
        <span className="text-sm leading-none">{current.flag}</span>
        <span className="text-xs font-medium uppercase">{current.code}</span>
      </button>
      {open && (
        <DropdownContainer>
          {languages.map(lang => (
            <MenuItem
              key={lang.code}
              label={lang.label}
              icon={<span className="text-sm">{lang.flag}</span>}
              active={activeLocale === lang.code}
              onClick={() => { setActiveLocale(lang.code); setOpen(false); trace.action('toolbar:locale', { lang: lang.code }); }}
            />
          ))}
        </DropdownContainer>
      )}
    </div>
  );
}

// ─── Theme Switcher ─────────────────────────────────────────────────────────

function ThemeSwitcher() {
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));

  const toggle = useCallback(() => {
    const next = !isDark;
    const root = document.documentElement;
    // Smooth the flip: `.theme-transition` (globals.css) eases every
    // color / background / border on the editor chrome for the duration
    // of the toggle, then we drop it so the transition doesn't ride along
    // on unrelated background changes (drags, hovers, selection).
    root.classList.add('theme-transition');
    setIsDark(next);
    if (next) root.classList.add('dark');
    else root.classList.remove('dark');
    window.setTimeout(() => root.classList.remove('theme-transition'), 200);
    trace.action('toolbar:theme-toggle', { dark: next });
  }, [isDark]);

  return (
    // Plain ToolButton — no permanent background, hover-only highlight,
    // exactly like the comment tool (and how it was before). The icon swap
    // stays JS-animated (framer-motion) so the flip is still smooth.
    <ToolButton onClick={toggle} title={isDark ? 'Theme: Dark' : 'Theme: Light'} dataTutorial="theme-tool">
      {/* Icon swap is JS-animated (framer-motion) rather than CSS so it
          stays smooth even while `.theme-transition` overrides CSS
          transitions globally during the flip. The new icon rotates +
          fades + scales in. `key` change remounts → plays the enter. */}
      <motion.span
        key={isDark ? 'sun' : 'moon'}
        initial={{ opacity: 0, rotate: -90, scale: 0.4 }}
        animate={{ opacity: 1, rotate: 0, scale: 1 }}
        transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
        className="flex items-center justify-center w-[22px] h-[22px]"
      >
        {isDark
          ? <ThemeSunIcon className="w-[22px] h-[22px]" />
          : <ThemeMoonIcon className="w-[22px] h-[22px]" />
        }
      </motion.span>
    </ToolButton>
  );
}

// ─── Main BottomToolbar ─────────────────────────────────────────────────────

export default function BottomToolbar() {
  const [toolMode, setToolMode] = useAtom(toolModeAtom);
  // DIAGNOSTIC (temporary): when does the toolbar re-render, and what toolMode
  // does it see? Pairs with border-radius-handle:state to test whether the
  // tool-reset lands in a later (deferred) commit than the selection.
  trace.action('bottom-toolbar:render', { toolMode });
  const [commentModeActive, setCommentModeActive] = useAtom(commentModeActiveAtom);
  // Viewers get a stripped toolbar: zoom · locale · theme · comment.
  // Every creator tool and the ⌘K search are hidden — none of them do
  // anything useful for a read-only seat.
  //
  // The Upgrade button used to live here, as an accent pill at the right
  // end of the floating bar. It moved to the logo menu (LeftHeader) under
  // "Your Account": a billing nudge belongs with the other account actions,
  // and a permanent accent pill floating over the canvas was the loudest
  // thing on screen for something the user acts on roughly once.
  const isViewer = useIsViewer();
  // Offline is a stricter case than role-viewer: a role-viewer MAY
  // comment, but an offline user may NOT (the comment can't be
  // persisted/synced), so the comment tool is hidden when offline.
  const isOffline = useIsOffline();
  const togglePalette = usePaletteToggle();
  const selectedId = useAtomValue(selectedNodeAtom);
  const activeFile = useAtomValue(activeFilePathAtom);
  const isIconSetMaster = isIconSetFilePath(activeFile);
  // Container-set (icon-set) masters suppress the
  // shared creators (Frame / Text / Layout). The kind-specific
  // tools stay visible:
  //   - icon-set master  → shape tools (rect / circle / triangle / path)
  const isContainerSetMaster = isIconSetMaster;
  const handleToolClick = useCallback((mode: ToolMode) => {
    trace.action('toolbar:tool-click', { mode });
    setToolMode(toolMode === mode && mode !== 'select' ? 'select' : mode);
    // Picking a creator tool exits comment mode (mutually exclusive,
    // mirrors the builder's behavior).
    if (commentModeActive) setCommentModeActive(false);
  }, [toolMode, setToolMode, commentModeActive, setCommentModeActive]);

  // Cursor / Hand selection — same as picking any tool, comment mode is
  // mutually exclusive so selecting the cursor exits it. Clicking the
  // cursor button while in comment mode is the user's "back to V".
  const handleSelectTool = useCallback((mode: ToolMode) => {
    trace.action('toolbar:select-tool', { mode });
    setToolMode(mode);
    if (commentModeActive) setCommentModeActive(false);
  }, [setToolMode, commentModeActive, setCommentModeActive]);

  const handleCommentClick = useCallback(() => {
    // Offline → commenting is unavailable (button hidden + this guard
    // covers the Ctrl+Alt+C shortcut, which routes through here).
    if (isOffline) return;
    const next = !commentModeActive;
    trace.action('toolbar:comment', { active: next });
    setCommentModeActive(next);
    // Entering comment mode forces select tool — the canvas needs to be
    // in a "do nothing on click" state so our own click handler can
    // place comments without competing with frame/text/shape creators.
    if (next && toolMode !== 'select') setToolMode('select');
  }, [isOffline, commentModeActive, setCommentModeActive, toolMode, setToolMode]);

  // Going offline force-exits comment mode — otherwise a thread left
  // open before the drop would keep the canvas-click placement handler
  // (in Comments.tsx) live even though the toolbar button is gone.
  useEffect(() => {
    if (isOffline && commentModeActive) setCommentModeActive(false);
  }, [isOffline, commentModeActive, setCommentModeActive]);

  // Ctrl+Alt+C → toggle comment mode (matches the builder shortcut).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.altKey) return;
      if (e.key.toLowerCase() !== 'c') return;
      const target = e.target as HTMLElement | null;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable) return;
      e.preventDefault();
      handleCommentClick();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleCommentClick]);

  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 z-[9998] flex justify-center select-none"
      // Floating pill — detached from the screen edge (was bottom:0 docked
      // with rounded-top-only), so the toolbar hovers slightly above the
      // bottom. CommandPalette measures #bottom-toolbar-container's live
      // rect, so anchored UI tracks the offset automatically.
      style={{ bottom: 'var(--float-gap)', willChange: 'transform', isolation: 'isolate' }}
    >
      <div id="bottom-toolbar-container" className="bg-[var(--bg-surface)] flex items-center px-2 p-1.5 rounded-xl border border-[var(--border-light)] shadow-lg gap-0.5">
        {/* ── Cursor / Hand ── Always shown, viewers included: a
            read-only seat can't draw, but it CAN still select nodes for
            inspection and pan the canvas, so the cursor/hand tool stays
            available (and its V / H shortcuts stay live). */}
        <CursorDropdown toolMode={toolMode} commentModeActive={commentModeActive} onSelect={handleSelectTool} />
        {/* Viewers have no other creator tools, so the cursor needs its
            own trailing separator before zoom. Non-viewers get one from
            the creator cluster below instead. */}
        {isViewer && <Separator />}

        {/* Creator tools — hidden in viewer mode. A read-only seat
            can't draw frames / text / shapes / sketches, so the
            authoring cluster (frame → sketch + its separator) collapses,
            leaving cursor · zoom · locale · theme · comment. */}
        {!isViewer && <>
        {/* Frame / Text / Layout are hidden on container-set master
            files (icon-set). The surface is a focused
            authoring context — icons hold vector shapes; it doesn't
            benefit from layout chrome. */}
        {!isContainerSetMaster && (
          <ToolButton active={toolMode === 'frame'} onClick={() => handleToolClick('frame')} title="Draw Frame (F)" dataTutorial="frame-tool">
            <FrameToolbarIcon className="w-[22px] h-[22px]" />
          </ToolButton>
        )}

        {!isContainerSetMaster && (
          <ToolButton active={toolMode === 'text'} onClick={() => handleToolClick('text')} title="Draw Text (T)" dataTutorial="text-tool">
            <TextToolbarIcon className="w-[22px] h-[22px]" />
          </ToolButton>
        )}

        {/* ── Shapes ── */}
        {/* Layout — page / component-master only. Icon masters
            are leaf authoring surfaces with no layout primitives.
            Placed BEFORE shapes so the toolbar reads
            cursor → frame → text → layout → shape → sketch, mirroring
            the user's mental order (structure before primitives). */}
        {!isContainerSetMaster && (
          <LayoutDropdown toolMode={toolMode} onSelect={(layout) => {
            const layoutToMode: Record<string, ToolMode> = {
              rows: 'layout-rows',
              columns: 'layout-columns',
              grids: 'layout-grids',
            };
            const mode = layoutToMode[layout];
            if (mode) {
              trace.action('toolbar:layout', { layout, mode });
              setToolMode(toolMode === mode ? 'select' : mode);
            }
          }} />
        )}

        {/* Drawing shapes is the primary action on a vector master, so the
            individual shape tools are surfaced inline as their own buttons
            (no chevron, no dropdown) — matches Figma's vector edit toolbar.
            On regular pages the shapes stay collapsed in the split-button
            dropdown to keep the toolbar compact. */}
        {isIconSetMaster ? (
          <>
            <ToolButton active={toolMode === 'shape-rect'} onClick={() => handleToolClick('shape-rect')} title="Square (R)">
              <ShapeSquareIcon className="w-[22px] h-[22px]" size={22} />
            </ToolButton>
            <ToolButton active={toolMode === 'shape-ellipse'} onClick={() => handleToolClick('shape-ellipse')} title="Circle (O)">
              <ShapeCircleIcon className="w-[22px] h-[22px]" size={22} />
            </ToolButton>
            <ToolButton active={toolMode === 'shape-triangle'} onClick={() => handleToolClick('shape-triangle')} title="Triangle (Shift+T)">
              <ShapeTriangleIcon className="w-[22px] h-[22px]" size={22} />
            </ToolButton>
            <ToolButton active={toolMode === 'shape-path'} onClick={() => handleToolClick('shape-path')} title="Path (P)">
              <ShapePathIcon className="w-[22px] h-[22px]" size={22} />
            </ToolButton>
            {/* Sketch is part of vector sets now — freehand strokes bundle in
                alongside the vector shapes. */}
            <ToolButton active={toolMode === 'sketch'} onClick={() => handleToolClick('sketch')} title="Sketch (K)">
              <SketchPencilIcon className="w-[22px] h-[22px]" size={22} />
            </ToolButton>
          </>
        ) : (
          <ShapeDropdown
            active={isShapeMode(toolMode)}
            sketchActive={toolMode === 'sketch'}
            onSketch={() => handleToolClick('sketch')}
            onSelect={(shape) => {
              const shapeToMode: Record<string, ToolMode> = {
                square: 'shape-rect',
                circle: 'shape-ellipse',
                triangle: 'shape-triangle',
                path: 'shape-path',
              };
              const mode = shapeToMode[shape];
              if (mode) {
                trace.action('toolbar:shape', { shape, mode });
                setToolMode(mode);
              }
            }}
          />
        )}

        {/* Sketch — on normal pages it lives INSIDE the shape dropdown
            (sketches bundle into a Vector Set). */}

        <Separator />
        </>}

        {/* Standalone Hand (pan) button removed — the cursor button at
            the start of the toolbar already exposes Move (V) / Hand (H)
            via its dropdown, so a second hand button was redundant. */}

        {/* ── Zoom ── (always shown — viewers can pan/zoom) */}
        <ZoomDropdown selectedId={selectedId} />

        <Separator />

        {/* ── Search ── hidden for viewers (the command palette only
            exposes write actions). */}
        {!isViewer && <>
        <button
          title="Search (⌘K)"
          onClick={togglePalette}
          data-palette-toggle
          data-tutorial="search-tool"
          className="flex items-center gap-1.5 px-2.5 h-[32px] bg-[var(--grid-line)] border border-[var(--control-border)] hover:border-[var(--border-focus)] rounded-lg transition-all"
          style={{ cursor: 'pointer' }}
        >
          <SearchIcon className="w-4 h-4 text-[var(--text-tertiary)]" />
          <span className="text-[11px] text-[var(--text-tertiary)]">⌘K</span>
        </button>

        <Separator />
        </>}

        {/* ── Locale ── */}
        <LocaleDropdown />

        <Separator />

        {/* ── Theme Switcher ── */}
        <ThemeSwitcher />

        {/* ── Comments ── Hidden when offline: comments can't be
            persisted/synced without a connection. Role-viewers (online)
            still get it — they're allowed to comment. */}
        {!isOffline && (
          <ToolButton active={commentModeActive} onClick={handleCommentClick} title="Add Comment (Ctrl+Alt+C)" dataTutorial="comment-tool">
            <CommentBubbleIcon className="w-[22px] h-[22px]" />
          </ToolButton>
        )}

      </div>
    </div>
  );
}

// ─── Inline zoom SVGs ───────────────────────────────────────────────────────

const ZoomOutSvg = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width={16} height={16}>
    <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="8" y1="11" x2="14" y2="11" />
  </svg>
);

const ZoomInSvg = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width={16} height={16}>
    <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" />
  </svg>
);
