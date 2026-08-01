// PreviewFrame.tsx — Preview overlay with resize handles and viewport header.
// Covers the entire canvas area. Grip handles on left/right/top/bottom for resizing.
// Center header bar with width/height controls and device presets.
// Ported from old builder's preview-frame.tsx + PreviewHeader.tsx.

import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { DesktopViewportIcon, TabletViewportIcon, MobileViewportIcon, ReloadIcon } from '@/shared/icons';
import { trace } from '@/shared/debug-trace';

// ─── Device presets ─────────────────────────────────────────────────────────

const PRESETS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 375, height: 812 },
};

// ─── Component ──────────────────────────────────────────────────────────────

interface PreviewFrameProps {
  children: ReactNode;  // The iframe
  onReload?: () => void;
}

export default function PreviewFrame({ children, onReload }: PreviewFrameProps) {
  const [previewWidth, setPreviewWidth] = useState(PRESETS.desktop.width);
  const [previewHeight, setPreviewHeight] = useState(PRESETS.desktop.height);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [isDraggingH, setIsDraggingH] = useState(false);
  const [isDraggingV, setIsDraggingV] = useState(false);
  const [isDraggingTop, setIsDraggingTop] = useState(false);
  const [dragStartX, setDragStartX] = useState(0);
  const [dragStartY, setDragStartY] = useState(0);
  const [dragStartW, setDragStartW] = useState(0);
  const [dragStartH, setDragStartH] = useState(0);
  const [windowWidth, setWindowWidth] = useState(typeof window !== 'undefined' ? window.innerWidth : 1440);
  const [windowHeight, setWindowHeight] = useState(typeof window !== 'undefined' ? window.innerHeight : 900);

  // Track window size
  useEffect(() => {
    const handleResize = () => {
      setWindowWidth(window.innerWidth);
      setWindowHeight(window.innerHeight);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const currentWidth = isFullScreen ? windowWidth - 308 : previewWidth;  // 308 = left menu + panel
  const currentHeight = isFullScreen ? windowHeight - 52 : previewHeight; // 52 = header height

  // Derive active viewport from width
  const activeViewport = currentWidth <= PRESETS.mobile.width ? 'mobile'
    : currentWidth <= PRESETS.tablet.width ? 'tablet' : 'desktop';

  // ─── Drag handlers ──────────────────────────────────────────────────

  const handleHDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDraggingH(true);
    setDragStartX(e.clientX);
    setDragStartW(previewWidth);
    trace.action('preview-frame:drag-h-start', { width: previewWidth });
  }, [previewWidth]);

  const handleBottomDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDraggingV(true);
    setIsDraggingTop(false);
    setDragStartY(e.clientY);
    setDragStartH(previewHeight);
  }, [previewHeight]);

  const handleTopDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDraggingV(true);
    setIsDraggingTop(true);
    setDragStartY(e.clientY);
    setDragStartH(previewHeight);
  }, [previewHeight]);

  const handleDragMove = useCallback((e: MouseEvent) => {
    if (isDraggingH) {
      const dx = e.clientX - dragStartX;
      const newWidth = Math.max(320, Math.min(dragStartW + dx * 2, windowWidth - 100));
      setPreviewWidth(Math.round(newWidth));
    }
    if (isDraggingV) {
      const dy = e.clientY - dragStartY;
      const delta = isDraggingTop ? -dy : dy;
      const newHeight = Math.max(200, Math.min(dragStartH + delta * (isDraggingTop ? 2 : 1), windowHeight - 100));
      setPreviewHeight(Math.round(newHeight));
    }
  }, [isDraggingH, isDraggingV, isDraggingTop, dragStartX, dragStartY, dragStartW, dragStartH, windowWidth, windowHeight]);

  const handleDragEnd = useCallback(() => {
    setIsDraggingH(false);
    setIsDraggingV(false);
    trace.action('preview-frame:drag-end', { width: previewWidth, height: previewHeight });
  }, [previewWidth, previewHeight]);

  useEffect(() => {
    if (isDraggingH || isDraggingV) {
      document.addEventListener('mousemove', handleDragMove);
      document.addEventListener('mouseup', handleDragEnd);
      return () => {
        document.removeEventListener('mousemove', handleDragMove);
        document.removeEventListener('mouseup', handleDragEnd);
      };
    }
  }, [isDraggingH, isDraggingV, handleDragMove, handleDragEnd]);

  // ─── Viewport select ────────────────────────────────────────────────

  const handleViewportSelect = useCallback((vp: string) => {
    const preset = PRESETS[vp as keyof typeof PRESETS];
    if (preset) {
      setPreviewWidth(preset.width);
      setIsFullScreen(false);
      trace.action('preview-frame:viewport-select', { viewport: vp, width: preset.width });
    }
  }, []);

  // ─── Render ─────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-[9997] flex flex-col" style={{ marginLeft: 0 }}>
      {/* Header bar — fills the top, between left and right headers */}
      <div
        className="h-[52px] bg-[var(--bg-surface)] border-b border-[var(--border-light)] flex items-center justify-center shrink-0"
        style={{ position: 'relative', zIndex: 9999 }}
      >
        <div className="flex items-center gap-3">
          {/* Full screen toggle */}
          <button
            onClick={() => setIsFullScreen(!isFullScreen)}
            className={`h-7 px-2.5 text-xs font-medium rounded-[var(--radius-lg)] transition-colors cursor-pointer border-none ${
              isFullScreen
                ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                : 'bg-[var(--button-secondary-bg)] text-[var(--text-primary)] hover:bg-[var(--button-secondary-hover)]'
            }`}
          >
            Full
          </button>

          {/* Width input */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-[var(--text-tertiary)] font-medium">W</span>
            <input
              type="number"
              value={isFullScreen ? currentWidth : previewWidth}
              onChange={(e) => {
                const v = parseInt(e.target.value);
                if (v >= 320) { setPreviewWidth(v); setIsFullScreen(false); }
              }}
              className="w-16 h-7 px-2 text-xs bg-[var(--control-bg)] border border-[var(--control-border)] rounded-[var(--radius-lg)] text-[var(--text-primary)] text-center focus:outline-none focus:border-[var(--border-focus)]"
            />
          </div>

          {/* Height input */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-[var(--text-tertiary)] font-medium">H</span>
            <input
              type="number"
              value={isFullScreen ? currentHeight : previewHeight}
              onChange={(e) => {
                const v = parseInt(e.target.value);
                if (v >= 200) { setPreviewHeight(v); setIsFullScreen(false); }
              }}
              className="w-16 h-7 px-2 text-xs bg-[var(--control-bg)] border border-[var(--control-border)] rounded-[var(--radius-lg)] text-[var(--text-primary)] text-center focus:outline-none focus:border-[var(--border-focus)]"
            />
          </div>

          {/* Viewport presets */}
          <div className="flex items-center gap-0.5 bg-[var(--button-secondary-bg)] rounded-[var(--radius-lg)] p-0.5">
            {[
              { id: 'desktop', Icon: DesktopViewportIcon },
              { id: 'tablet', Icon: TabletViewportIcon },
              { id: 'mobile', Icon: MobileViewportIcon },
            ].map(({ id, Icon }) => (
              <button
                key={id}
                onClick={() => handleViewportSelect(id)}
                className={`p-1.5 rounded-[var(--radius-lg)] transition-colors cursor-pointer border-none ${
                  activeViewport === id
                    ? 'bg-[var(--bg-surface)] shadow-sm'
                    : 'hover:bg-[var(--bg-hover)]'
                }`}
              >
                <Icon className="w-4 h-4" style={{ color: activeViewport === id ? 'var(--text-primary)' : 'var(--text-tertiary)' }} />
              </button>
            ))}
          </div>

          {/* Reload */}
          {onReload && (
            <button
              onClick={onReload}
              className="h-7 px-2 rounded-[var(--radius-lg)] bg-[var(--button-secondary-bg)] hover:bg-[var(--button-secondary-hover)] transition-colors cursor-pointer border-none"
            >
              <ReloadIcon className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} />
            </button>
          )}

          {/* Dimensions display */}
          <span className="text-[11px] text-[var(--text-tertiary)] font-mono tabular-nums">
            {Math.round(currentWidth)} × {Math.round(currentHeight)}
          </span>
        </div>
      </div>

      {/* Preview area */}
      <div className="flex-1 bg-[var(--bg-canvas)] flex items-center justify-center relative overflow-hidden">
        {/* Left grip handle */}
        {!isFullScreen && (
          <div
            className="absolute top-0 bottom-0 flex items-center justify-center z-10 group cursor-ew-resize"
            style={{ left: `calc(50% - ${currentWidth / 2}px - 15px)`, width: 15 }}
            onMouseDown={handleHDragStart}
          >
            <div className="w-1 h-16 bg-gray-300 group-hover:bg-[var(--accent)] transition-colors rounded-full opacity-60 group-hover:opacity-100" />
          </div>
        )}

        {/* Right grip handle */}
        {!isFullScreen && (
          <div
            className="absolute top-0 bottom-0 flex items-center justify-center z-10 group cursor-ew-resize"
            style={{ left: `calc(50% + ${currentWidth / 2}px)`, width: 15 }}
            onMouseDown={handleHDragStart}
          >
            <div className="w-1 h-16 bg-gray-300 group-hover:bg-[var(--accent)] transition-colors rounded-full opacity-60 group-hover:opacity-100" />
          </div>
        )}

        {/* Top grip handle */}
        {!isFullScreen && (
          <div
            className="absolute flex items-center justify-center z-10 group cursor-ns-resize"
            style={{
              top: `calc(50% - ${currentHeight / 2}px - 15px)`,
              left: `calc(50% - ${currentWidth / 2}px)`,
              width: currentWidth, height: 15,
            }}
            onMouseDown={handleTopDragStart}
          >
            <div className="h-1 w-16 bg-gray-300 group-hover:bg-[var(--accent)] transition-colors rounded-full opacity-60 group-hover:opacity-100" />
          </div>
        )}

        {/* Bottom grip handle */}
        {!isFullScreen && (
          <div
            className="absolute flex items-center justify-center z-10 group cursor-ns-resize"
            style={{
              top: `calc(50% + ${currentHeight / 2}px)`,
              left: `calc(50% - ${currentWidth / 2}px)`,
              width: currentWidth, height: 15,
            }}
            onMouseDown={handleBottomDragStart}
          >
            <div className="h-1 w-16 bg-gray-300 group-hover:bg-[var(--accent)] transition-colors rounded-full opacity-60 group-hover:opacity-100" />
          </div>
        )}

        {/* Preview iframe container */}
        <div
          className="relative overflow-hidden"
          style={{
            width: isFullScreen ? '100%' : currentWidth,
            height: isFullScreen ? '100%' : currentHeight,
          }}
        >
          {children}
        </div>

        {/* Drag overlay — blocks iframe pointer events during resize */}
        {(isDraggingH || isDraggingV) && (
          <div className={`absolute inset-0 z-20 ${isDraggingH ? 'cursor-ew-resize' : 'cursor-ns-resize'}`} />
        )}
      </div>
    </div>
  );
}
