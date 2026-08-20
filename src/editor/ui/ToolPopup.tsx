// ToolPopup.tsx — Floating popup with sliding panel navigation.
// Supports nested views: click a sub-control → slides right to new panel.
// Back arrow ← slides left to previous panel. Like the reference's Effect popup.
// Portal to body, close on Escape or outside click.

import { useEffect, useRef, useState, useCallback, createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { trace } from '@/shared/debug-trace';

// ─── Context for child components to push/pop panels ────────────────────────

interface ToolPopupContextValue {
  /**
   * Push a new panel (slides right). Pass a render function for content
   * that needs to track parent prop changes (e.g. ColorPicker showing the
   * just-applied preset as active) — the function is invoked on every
   * ToolPopup render, so closures-over-refs in the parent stay fresh.
   * Plain ReactNode is fine for content that's truly static after push.
   */
  pushPanel: (title: string, content: ReactNode | (() => ReactNode)) => void;
  /** Pop to previous panel (slides left) */
  popPanel: () => void;
}

export const ToolPopupContext = createContext<ToolPopupContextValue | null>(null);

/** Hook for child components to navigate within the popup (throws if not inside) */
export function useToolPopup(): ToolPopupContextValue {
  const ctx = useContext(ToolPopupContext);
  if (!ctx) throw new Error('useToolPopup must be inside a ToolPopup');
  return ctx;
}

/** Optional version — returns null if not inside a ToolPopup */
export function useToolPopupOptional(): ToolPopupContextValue | null {
  return useContext(ToolPopupContext);
}

/**
 * Renders a stacked-panel render function as a component.
 *
 * Why this exists: if we inline `panel.content()` directly inside ToolPopup's
 * JSX, the function runs DURING ToolPopup's render. React renders top-down
 * left-to-right, so at that point the root panel (where ColorInput lives and
 * updates its refs) hasn't rendered yet — the function reads STALE refs and
 * the picker shows the old preset until something else triggers another
 * render.
 *
 * Wrapping the function in a component makes the call happen during *that
 * component's* render, which React schedules AFTER the root panel's tree is
 * rendered. By then the parent's refs have been assigned for the current
 * cycle and the picker reflects the just-applied preset immediately.
 */
function PanelRender({ render }: { render: () => ReactNode }) {
  return <>{render()}</>;
}

// ─── Global singleton — only one ToolPopup open at a time ────────────────────

// Track last pointerdown Y so popups open at click level.
// Only track clicks OUTSIDE existing popups (not during color picker drag, etc.)
let _lastClickY = 0;
document.addEventListener('pointerdown', (e) => {
  if (!(e.target as HTMLElement).closest('[data-tool-popup]')) {
    _lastClickY = e.clientY;
  }
}, true);

let globalCloseCallback: (() => void) | null = null;

function registerAsActivePopup(closeFn: () => void) {
  // Close any previously open popup
  if (globalCloseCallback && globalCloseCallback !== closeFn) {
    globalCloseCallback();
  }
  globalCloseCallback = closeFn;
}

function unregisterActivePopup(closeFn: () => void) {
  if (globalCloseCallback === closeFn) {
    globalCloseCallback = null;
  }
}

/** Close the currently-open ToolPopup (e.g. the Fill color/gradient picker) from
 *  OUTSIDE React — the canvas-background click handler calls this so one click
 *  dismisses the floating picker. Closing it unmounts the gradient/clip-path/color
 *  editors, whose unmount cleanups revert their overlay atoms. No-op when nothing
 *  is open. */
export function closeActiveToolPopup(): void {
  globalCloseCallback?.();
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface Panel {
  title: string;
  /** Either a static ReactNode or a render function. The function form is
   *  invoked on each ToolPopup render so refs/state captured by the caller
   *  produce fresh JSX without us having to replace the panel manually. */
  content: ReactNode | (() => ReactNode);
  /** pos.y captured at push time — restored when this panel is popped */
  savedY: number;
}

interface ToolPopupProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Reference element to position against (the Edit button) */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Popup width (default 260px — matches sidebar) */
  width?: number;
  /** When this value changes, panel stack resets to root (for selection reactivity) */
  resetKey?: string | number;
  /** Which side to position the popup relative to the anchor. Default 'left' (opens to the left of anchor). */
  side?: 'left' | 'right';
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function ToolPopup({ isOpen, onClose, title, children, anchorRef, width = 260, resetKey, side = 'left' }: ToolPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  const activePanelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [positioned, setPositioned] = useState(false);
  const [panelStack, setPanelStack] = useState<Panel[]>([]);
  const [contentHeight, setContentHeight] = useState<number | 'auto'>('auto');
  // Cap on the active panel's measured height. When the natural content
  // would be taller than the viewport (e.g. Scroll Transform with many
  // section milestones), we clamp the outer height-animated container to
  // this value AND make the inner panel scroll its overflow internally —
  // matches the reference's "popup pinned at usable height + scrollbar inside".
  const [maxContentHeight, setMaxContentHeight] = useState<number>(() => {
    // Headers + top/bottom gap + a little breathing room ≈ 100px.
    return Math.max(200, window.innerHeight - 100);
  });
  useEffect(() => {
    const onResize = () => setMaxContentHeight(Math.max(200, window.innerHeight - 100));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  // True only during panel navigation so `top` animates simultaneously with height spring.
  // Cleared immediately after so popup drag stays instant.
  const [animateTop, setAnimateTop] = useState(false);
  const animateTopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Always-current ref so pushPanel/popPanel don't need pos in their dep arrays
  const posRef = useRef(pos);
  posRef.current = pos;
  // Y saved before the first upward reposition (e.g. growing tab content).
  // Restored when content shrinks back — mirrors pushPanel/popPanel save/restore.
  const preGrowthYRef = useRef<number | null>(null);

  // Reset panel stack when popup opens/closes
  useEffect(() => {
    if (!isOpen) { setPanelStack([]); setContentHeight('auto'); preGrowthYRef.current = null; }
  }, [isOpen]);

  // Reset panel stack when resetKey changes (e.g. node selection change)
  useEffect(() => {
    if (resetKey !== undefined && panelStack.length > 0) {
      trace.action('tool-popup:reset-key', { resetKey, clearedPanels: panelStack.length });
      setPanelStack([]);
      setContentHeight('auto');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  // Measure active panel height and animate container.
  // Depends on isOpen so the observer is re-established each time the popup opens
  // (panelStack.length stays 0 across open/close, so it alone doesn't retrigger).
  useEffect(() => {
    if (!isOpen) return;
    const el = activePanelRef.current;
    if (!el) { setContentHeight('auto'); return; }
    // Cap to maxContentHeight so a tall panel (many sections) doesn't
    // grow the popup past the viewport. The panel itself gets a matching
    // maxHeight + overflow-y-auto below, so content beyond the cap is
    // reachable via scroll inside the popup.
    const measure = () => setContentHeight(Math.min(el.scrollHeight, maxContentHeight));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [panelStack.length, isOpen, maxContentHeight]);

  // Current panel (top of stack, or root)
  const currentPanel = panelStack.length > 0 ? panelStack[panelStack.length - 1] : null;
  const currentTitle = currentPanel?.title ?? title;
  const currentContent = currentPanel?.content ?? children;
  const canGoBack = panelStack.length > 0;

  // ─── Panel navigation ─────────────────────────────────────
  const pushPanel = useCallback((panelTitle: string, content: ReactNode | (() => ReactNode)) => {
    // Save current Y so popPanel can restore it (panel B may push popup up; going back should restore panel A's Y)
    const savedY = posRef.current.y;
    trace.action('tool-popup:push-panel', { title: panelTitle, depth: panelStack.length + 1, savedY });
    setPanelStack(prev => [...prev, { title: panelTitle, content, savedY }]);
  }, [panelStack.length]);

  const popPanel = useCallback(() => {
    setPanelStack(prev => {
      const topPanel = prev[prev.length - 1];
      if (topPanel) {
        trace.action('tool-popup:pop-panel', { depth: prev.length - 1, restoringY: topPanel.savedY });
        // Restore the Y position from before this panel was pushed, using the spring animation
        setAnimateTop(true);
        if (animateTopTimerRef.current) clearTimeout(animateTopTimerRef.current);
        animateTopTimerRef.current = setTimeout(() => setAnimateTop(false), 350);
        setPos(p => ({ ...p, y: topPanel.savedY }));
      }
      return prev.slice(0, -1);
    });
  }, []);

  // ─── Positioning (recalculates on open + window resize) ───
  // Store anchorRef in a stable ref to avoid recalcPosition dependency on anchorRef object identity
  const anchorRefStable = useRef(anchorRef);
  anchorRefStable.current = anchorRef;

  const recalcPosition = useCallback(() => {
    // Anchor may be null when the caller hands us a ref whose element
    // isn't rendered yet — e.g. AnimationTool's auto-open after handleAdd
    // fires the popup BEFORE the just-added entry has flushed into
    // `detected`, so the ToolSection (which renders only when
    // `hasContent={true}`) is empty and the anchor div doesn't exist
    // yet. Fall through to the properties-panel anchor (same path the
    // detached-element branch already uses) instead of early-returning,
    // which would otherwise leave the popup parked at (0,0) opacity:0.
    const anchor = anchorRefStable.current?.current ?? null;
    const rect = anchor
      ? anchor.getBoundingClientRect()
      : { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 } as DOMRect;
    const gap = 16;

    // Detect detached element (React re-rendered and old ref is stale)
    // or missing element (anchor was null).
    const isDetached = !anchor || (rect.left === 0 && rect.right === 0 && rect.top === 0 && rect.width === 0);

    // Find the properties panel — from anchor if attached, or directly from DOM
    const sidebar = isDetached
      ? document.querySelector('[data-properties-panel]') as HTMLElement
      : (anchor!.closest('[data-properties-panel]') as HTMLElement
        || anchor!.closest('[class*="w-[260px"]') as HTMLElement);

    let x: number;
    if (side === 'right') {
      x = (isDetached ? (sidebar?.getBoundingClientRect().right || window.innerWidth) : rect.right) + gap / 2;
      if (x + width > window.innerWidth - gap) x = window.innerWidth - width - gap;
    } else {
      if (sidebar) {
        x = sidebar.getBoundingClientRect().left - width - gap;
      } else {
        x = (isDetached ? window.innerWidth - 260 : rect.left) - width - gap;
      }
    }
    if (x < gap) x = gap;

    // Use last click Y position so popup opens at click level
    let y = _lastClickY - 20; // offset slightly above click
    const estimatedHeight = popupRef.current?.offsetHeight || 400;
    if (y + estimatedHeight > window.innerHeight - gap) {
      y = Math.max(gap, window.innerHeight - estimatedHeight - gap);
    }
    if (y < gap) y = gap;

    setPos({ x, y });
    setPositioned(true);
    preGrowthYRef.current = null; // fresh open — forget any previous growth state
  }, [width, side]);

  // Keep onClose in a ref so the open effect doesn't re-run when parent re-renders
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) { setPositioned(false); return; }
    // Close any other open popup (global singleton)
    const closeFn = () => onCloseRef.current();
    registerAsActivePopup(closeFn);
    setPositioned(false);
    // Position on next frame so DOM is measured correctly
    requestAnimationFrame(() => recalcPosition());
    trace.action('tool-popup:open', { title });

    // Reposition on window resize
    const handleResize = () => recalcPosition();
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      unregisterActivePopup(closeFn);
    };
  }, [isOpen, recalcPosition, title]); // onClose removed from deps — uses ref

  // ─── Reposition whenever content height changes (tabs, panels, any resize) ──
  // Guard: only runs AFTER initial positioning — prevents jump caused by the
  // effect firing at top=0 before recalcPosition has set the correct position.
  // Also implements save/restore of Y across content height changes so that
  // switching tabs (Color→Gradient→Color) restores the pre-expansion position.
  useEffect(() => {
    if (!isOpen || !positioned || contentHeight === 'auto') return;
    const popupEl = popupRef.current;
    if (!popupEl) return;
    const gap = 16;
    const headerEl = popupEl.querySelector<HTMLElement>(':scope > div:first-child');
    const headerHeight = headerEl?.offsetHeight ?? 44;
    const totalHeight = headerHeight + contentHeight;
    const currentTop = popupEl.getBoundingClientRect().top;

    if (currentTop + totalHeight > window.innerHeight - gap) {
      // Content grew and is overflowing — save current Y (once) then move up
      if (preGrowthYRef.current === null) {
        preGrowthYRef.current = currentTop;
        trace.action('tool-popup:save-pre-growth-y', { savedY: currentTop });
      }
      const newY = Math.max(gap, window.innerHeight - totalHeight - gap);
      trace.action('tool-popup:reposition-for-height', { contentHeight, totalHeight, currentTop, newY });
      setAnimateTop(true);
      if (animateTopTimerRef.current) clearTimeout(animateTopTimerRef.current);
      animateTopTimerRef.current = setTimeout(() => setAnimateTop(false), 350);
      setPos(prev => prev.y === newY ? prev : { ...prev, y: newY });
    } else if (preGrowthYRef.current !== null) {
      // Content shrank back — restore the pre-growth Y (clamped to fit new height)
      const maxY = window.innerHeight - totalHeight - gap;
      const restoreY = Math.min(preGrowthYRef.current, maxY);
      preGrowthYRef.current = null;
      trace.action('tool-popup:restore-pre-growth-y', { restoreY, currentTop });
      if (restoreY !== currentTop) {
        setAnimateTop(true);
        if (animateTopTimerRef.current) clearTimeout(animateTopTimerRef.current);
        animateTopTimerRef.current = setTimeout(() => setAnimateTop(false), 350);
        setPos(prev => ({ ...prev, y: restoreY }));
      }
    }
  // pos intentionally excluded — we read live DOM position instead
   
  }, [contentHeight, isOpen, positioned]);

  // ─── Escape key ───────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (canGoBack) popPanel();
        else onClose();
      }
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [isOpen, onClose, canGoBack, popPanel]);

  // ─── Draggable header ────────────────────────────────────
  const dragRef = useRef({ dragging: false, startX: 0, startY: 0, origX: 0, origY: 0 });

  const handleDragStart = useCallback((e: React.PointerEvent) => {
    // Only drag from the header area, not buttons
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    dragRef.current = { dragging: true, startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };

    const handleMove = (me: PointerEvent) => {
      if (!dragRef.current.dragging) return;
      const dx = me.clientX - dragRef.current.startX;
      const dy = me.clientY - dragRef.current.startY;
      setPos({ x: dragRef.current.origX + dx, y: dragRef.current.origY + dy });
    };
    const handleUp = () => {
      dragRef.current.dragging = false;
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', handleUp);
    };
    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', handleUp);
  }, [pos.x, pos.y]);

  // Popup closes via: × button, Escape key, or global singleton.

  // AUTO-CLOSE ON EMPTY CONTENT — when the ACTIVE panel renders NOTHING,
  // the entity this editor was editing no longer exists (an undo removed
  // the sort rule / mask entry / … while its editor was open) and the shell
  // would linger as an empty titled box (the Collection List "Order" popup
  // report). A pushed panel pops back to its parent list; the root panel
  // closes the popup. No deps: runs after every commit — the tools
  // re-render on undo (node subscriptions), which re-renders this popup and
  // its children in the same commit, so the emptiness check sees the fresh
  // content.
  useEffect(() => {
    if (!isOpen) return;
    const el = activePanelRef.current;
    const inner = el?.firstElementChild as HTMLElement | null;
    if (!inner) return;
    if (inner.childElementCount === 0 && (inner.textContent ?? '').trim() === '') {
      trace.action('tool-popup:auto-close-empty', { stacked: panelStack.length > 0, title });
      if (panelStack.length > 0) popPanel(); else onClose();
    }
  });

  if (!isOpen) return null;

  // z-index: normally 100001 (above the canvas / tools). But when this popup is triggered from
  // INSIDE a modal (anchor is within `[data-modal-root]`, e.g. the variable modal's default-value
  // editor), it must sit ABOVE the modal (100010) or it opens BEHIND it and can't be used. Bump to
  // 100020 in that case.
  const inModal = !!anchorRef?.current?.closest?.('[data-modal-root]');
  const zIndex = inModal ? 100020 : 100001;

  return createPortal(
    <ToolPopupContext.Provider value={{ pushPanel, popPanel }}>
      <motion.div
        ref={popupRef}
        data-tool-popup=""
        className="fixed bg-[var(--bg-surface)] border border-[var(--border-light)] cut-corners cut-lg cut-border shadow-2xl flex flex-col overflow-hidden"
        // initial ensures the very first paint is invisible — prevents the
        // one-frame flash at left:0/top:0 before recalcPosition runs.
        // initial: first paint is invisible — prevents the one-frame flash at
        // left:0/top:0 before recalcPosition runs on the rAF.
        initial={{ opacity: 0, scale: 0.97, x: side === 'left' ? 6 : -6 }}
        // zIndex: 100001 normally; 100020 when triggered from inside a modal (the modal root is
        // 100010) so the popup — e.g. the Border / Shadow / Color editor in the variable modal's
        // default-value section — renders OVER the modal instead of buried behind it. See `inModal`.
        // --cut-border-color pinned to border-light: the popup's rect border
        // is border-light, not the control-border the .cut-border fallback
        // assumes.
        style={{ width, zIndex, '--cut-border-color': 'var(--border-light)' } as React.CSSProperties}
        // Entrance: fade + subtle scale + slide from the anchor side.
        // left/top always snap instantly; animateTop enables spring for top only.
        animate={positioned ? {
          left: pos.x, top: pos.y, opacity: 1, scale: 1, x: 0,
        } : {
          left: pos.x, top: pos.y, opacity: 0, scale: 0.97, x: side === 'left' ? 6 : -6,
        }}
        transition={animateTop ? {
          left:    { duration: 0 },
          top:     { type: 'spring', stiffness: 400, damping: 40 },
          opacity: { duration: 0.12, ease: 'easeOut' },
          scale:   { duration: 0.12, ease: 'easeOut' },
          x:       { duration: 0.12, ease: 'easeOut' },
        } : {
          left:    { duration: 0 },
          top:     { duration: 0 },
          opacity: { duration: 0.12, ease: 'easeOut' },
          scale:   { duration: 0.12, ease: 'easeOut' },
          x:       { duration: 0.12, ease: 'easeOut' },
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header — draggable, back arrow when navigated, title, close × */}
        <div className="flex items-center justify-between px-3 pt-3 pb-1.5 cursor-grab active:cursor-grabbing select-none"
          onPointerDown={handleDragStart}>
          <div className="flex items-center gap-1.5">
            {canGoBack && (
              <button
                onClick={popPanel}
                className="p-0.5 hover:bg-[var(--bg-hover)] rounded transition-colors text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </button>
            )}
            <span className="text-xs font-bold text-[var(--text-primary)]">{currentTitle}</span>
          </div>
          <button
            onClick={onClose}
            className="p-0.5 hover:bg-[var(--bg-hover)] rounded transition-colors text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Sliding content — all panels laid out horizontally, spring animation */}
        {/* Height animates to fit the active panel */}
        <motion.div
          className="overflow-hidden"
          animate={{ height: contentHeight }}
          transition={{ type: 'spring', stiffness: 400, damping: 40 }}
        >
          <motion.div
            className="flex items-start"
            animate={{ x: `-${panelStack.length * 100}%` }}
            transition={{ type: 'spring', stiffness: 400, damping: 40 }}
          >
            {/* Root panel — `maxHeight + overflowY:auto` so tall content
                (many section milestones) scrolls inside the panel rather
                than growing the popup past the viewport. */}
            <div
              ref={panelStack.length === 0 ? activePanelRef : undefined}
              className="w-full flex-shrink-0 px-3 pb-3 pt-1 overflow-y-auto overflow-x-hidden scrollbar-hide"
              style={{ maxHeight: maxContentHeight }}
            >
              {/* Keyed by resetKey so the content REMOUNTS when the selected node/tile
                  changes — the children hold local useState (e.g. a Scroll Animation's
                  direction/replay), which a plain re-render wouldn't re-seed. Switching
                  Desktop→Tablet now instantly shows the active viewport's values. */}
              <div key={resetKey ?? 'root'} className="flex flex-col gap-3.5">
                {children}
              </div>
            </div>
            {/* Stacked panels */}
            {panelStack.map((panel, i) => (
              <div
                key={i}
                ref={i === panelStack.length - 1 ? activePanelRef : undefined}
                className="w-full flex-shrink-0 px-3 pb-3 pt-1 overflow-y-auto overflow-x-hidden scrollbar-hide"
                style={{ maxHeight: maxContentHeight }}
              >
                <div className="flex flex-col gap-3.5">
                  {typeof panel.content === 'function'
                    ? <PanelRender render={panel.content} />
                    : panel.content}
                </div>
              </div>
            ))}
          </motion.div>
        </motion.div>
      </motion.div>
    </ToolPopupContext.Provider>,
    document.body,
  );
}
