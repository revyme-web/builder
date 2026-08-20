// CodeEditorPopup.tsx — Floating, draggable, resizable code editor window.
// Opens when the Code (<>) button in LeftMenu is clicked.
// Drag from the titlebar. Resize from any edge or corner.

import { useState, useCallback } from 'react';
import { clamp } from '@/canvas/canvas-math';
import { useAtom } from 'jotai';
import { codeEditorOpenAtom } from '@/code/stores/left-panel-store';
import { useIsClosedSource } from '@/code/stores/closed-source-store';
import CodeEditor from './CodeEditor';
import { trace } from '@/shared/debug-trace';

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_W = 820;
const DEFAULT_H = 600;
const DEFAULT_X = 220;
const DEFAULT_Y = 80;
const MIN_W = 400;
const MIN_H = 300;
const EDGE = 5;    // resize edge hit area (px)
const CORNER = 14; // resize corner hit area (px)

// ─── Clamp helpers (pure — no state deps) ────────────────────────────────────

const clampX = (x: number) => clamp(x, 0, window.innerWidth - MIN_W);
const clampY = (y: number) => clamp(y, 0, window.innerHeight - 40);
const clampW = (w: number, x: number) => clamp(w, MIN_W, window.innerWidth - x);
const clampH = (h: number, y: number) => clamp(h, MIN_H, window.innerHeight - y);

// ─── Component ───────────────────────────────────────────────────────────────

export default function CodeEditorPopup() {
  const [open, setOpen] = useAtom(codeEditorOpenAtom);
  // Closed-source template remix — the code surface is hidden regardless of
  // which entry point flipped the atom (left menu, palette, shortcut).
  const isClosedSource = useIsClosedSource();
  const [pos, setPos] = useState({ x: DEFAULT_X, y: DEFAULT_Y });
  const [size, setSize] = useState({ w: DEFAULT_W, h: DEFAULT_H });

  // ─── Drag (titlebar) ───────────────────────────────────────────────────────

  const handleDragStart = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    const startX = e.clientX - pos.x;
    const startY = e.clientY - pos.y;
    trace.action('code-popup:drag-start', { x: pos.x, y: pos.y });

    const onMove = (ev: PointerEvent) => {
      setPos({ x: clampX(ev.clientX - startX), y: clampY(ev.clientY - startY) });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      trace.action('code-popup:drag-end');
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [pos.x, pos.y]);

  // ─── Resize (any edge / corner) ────────────────────────────────────────────

  const startResize = useCallback((
    e: React.PointerEvent,
    edges: { right?: boolean; bottom?: boolean; left?: boolean; top?: boolean },
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX;
    const sy = e.clientY;
    const sw = size.w;
    const sh = size.h;
    const spx = pos.x;
    const spy = pos.y;
    trace.action('code-popup:resize-start', { edges, sw, sh });

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;

      setSize(prev => {
        let w = prev.w;
        let h = prev.h;
        if (edges.right) w = clampW(sw + dx, spx);
        if (edges.left) w = clampW(sw - dx, spx + dx);
        if (edges.bottom) h = clampH(sh + dy, spy);
        if (edges.top) h = clampH(sh - dy, spy + dy);
        return { w, h };
      });
      setPos(prev => {
        let x = prev.x;
        let y = prev.y;
        if (edges.left) x = clampX(spx + dx);
        if (edges.top) y = clampY(spy + dy);
        return { x, y };
      });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      trace.action('code-popup:resize-end');
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [pos.x, pos.y, size.w, size.h]);

  if (!open || isClosedSource) return null;

  trace.fn('code-popup:render', { x: pos.x, y: pos.y, w: size.w, h: size.h });

  return (
    <div
      className="fixed flex flex-col overflow-hidden cut-corners shadow-2xl"
      style={{
        left: pos.x,
        top: pos.y,
        width: size.w,
        height: size.h,
        zIndex: 9990,
        background: 'var(--bg-panel)',
        border: '1px solid var(--border-light)',
      }}
    >
      {/* ─── Titlebar / drag handle ─────────────────────────────────────── */}
      <div
        className="flex items-center justify-between px-3 shrink-0 select-none"
        style={{
          height: 36,
          background: 'var(--bg-toolbar)',
          borderBottom: '1px solid var(--border-light)',
          cursor: 'grab',
        }}
        onPointerDown={handleDragStart}
      >
        <div className="flex items-center gap-2">
          {/* Code icon */}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-secondary)] shrink-0">
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
          </svg>
          <span className="text-[11px] font-semibold text-[var(--text-primary)]">Code Editor</span>
        </div>

        <button
          onClick={() => { setOpen(false); trace.action('code-popup:close-button'); }}
          className="w-5 h-5 flex items-center justify-center rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--button-secondary-bg)] transition-colors cursor-pointer border-none bg-transparent"
          style={{ fontSize: 16, lineHeight: 1 }}
          title="Close"
        >
          ×
        </button>
      </div>

      {/* ─── Editor content ─────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <CodeEditor />
      </div>

      {/* ─── Resize edges ───────────────────────────────────────────────── */}

      {/* Right edge */}
      <div
        className="absolute top-0 bottom-0 right-0 cursor-ew-resize"
        style={{ width: EDGE }}
        onPointerDown={(e) => startResize(e, { right: true })}
      />
      {/* Left edge */}
      <div
        className="absolute top-0 bottom-0 left-0 cursor-ew-resize"
        style={{ width: EDGE }}
        onPointerDown={(e) => startResize(e, { left: true })}
      />
      {/* Bottom edge */}
      <div
        className="absolute left-0 right-0 bottom-0 cursor-ns-resize"
        style={{ height: EDGE }}
        onPointerDown={(e) => startResize(e, { bottom: true })}
      />
      {/* Top edge (below titlebar to not conflict with drag) */}
      <div
        className="absolute left-0 right-0 cursor-ns-resize"
        style={{ top: 36, height: EDGE }}
        onPointerDown={(e) => startResize(e, { top: true })}
      />

      {/* Corners */}
      <div
        className="absolute bottom-0 right-0 cursor-nwse-resize"
        style={{ width: CORNER, height: CORNER }}
        onPointerDown={(e) => startResize(e, { right: true, bottom: true })}
      />
      <div
        className="absolute bottom-0 left-0 cursor-nesw-resize"
        style={{ width: CORNER, height: CORNER }}
        onPointerDown={(e) => startResize(e, { left: true, bottom: true })}
      />
      <div
        className="absolute top-[36px] right-0 cursor-nesw-resize"
        style={{ width: CORNER, height: CORNER }}
        onPointerDown={(e) => startResize(e, { right: true, top: true })}
      />
      <div
        className="absolute top-[36px] left-0 cursor-nwse-resize"
        style={{ width: CORNER, height: CORNER }}
        onPointerDown={(e) => startResize(e, { left: true, top: true })}
      />
    </div>
  );
}
