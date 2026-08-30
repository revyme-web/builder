// AIChatSheet.tsx — floating AI chat panel.
//
// A capped-size card that fades in (matching the ⌘K command palette), can be
// dragged anywhere by its header, and resized from the bottom-right corner.
// It opens as a card sitting just above the bottom toolbar.

import { motion } from 'framer-motion';
import { useState, type ReactNode } from 'react';
import { trace } from '@/shared/debug-trace';
import VibeComingSoonGate from './ui/VibeComingSoonGate';

const MIN_WIDTH = 320;
const MIN_HEIGHT = 160;
const DEFAULT_WIDTH = 420;
const DEFAULT_HEIGHT = 220;

interface Props {
  /** Optional accessory rendered in the header, right of the title
   *  (e.g. the credits indicator). */
  headerAccessory?: ReactNode;
  /** Name of the surface the chat is editing — shown after the title. */
  contextLabel?: string;
  /** Close the panel. */
  onClose: () => void;
  /** Panel body — messages list, input row, etc. */
  children: ReactNode;
}

export default function AIChatSheet({ headerAccessory, contextLabel, onClose, children }: Props) {
  const [size, setSize] = useState({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
  // Default: a card centered horizontally, sitting just above the toolbar.
  const [pos, setPos] = useState(() => ({
    x: Math.round(window.innerWidth / 2 - DEFAULT_WIDTH / 2),
    y: Math.round(window.innerHeight - 76 - DEFAULT_HEIGHT),
  }));

  // Page routes arrive slash-prefixed ("/", "/about") — drop the slash so the
  // header reads cleaner; "/" alone becomes "Home". Component / icon-set names
  // never start with "/", so this is a no-op for them.
  const surfaceLabel = contextLabel
    ? contextLabel.replace(/^\//, '') || 'Home'
    : undefined;

  // Drag the header → move the whole panel. Listeners live on `document` so
  // the drag survives the cursor leaving the 36px header. Clamped so the panel
  // can't be dragged fully off-screen.
  function startMove(e: React.PointerEvent) {
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const ox = pos.x;
    const oy = pos.y;
    const onMove = (me: PointerEvent) => {
      setPos({
        x: Math.min(window.innerWidth - 80, Math.max(8, ox + me.clientX - sx)),
        y: Math.min(window.innerHeight - 48, Math.max(56, oy + me.clientY - sy)),
      });
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      trace.action('ai-chat-sheet:moved');
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.body.style.cursor = 'grabbing';
  }

  // Drag the bottom-right corner → resize (both axes).
  function startResize(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX;
    const sy = e.clientY;
    const ow = size.width;
    const oh = size.height;
    const onMove = (me: PointerEvent) => {
      setSize({
        width: Math.max(MIN_WIDTH, ow + me.clientX - sx),
        height: Math.max(MIN_HEIGHT, oh + me.clientY - sy),
      });
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      trace.action('ai-chat-sheet:resized');
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.body.style.cursor = 'nwse-resize';
  }

  return (
    <motion.div
      data-ai-chat-sheet
      // Same fade-in as the ⌘K command palette.
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', bounce: 0.15, duration: 0.25 }}
      className="fixed z-[9990] flex flex-col overflow-hidden cut-corners cut-lg cut-border [--cut-border-color:var(--border-light)] border border-[var(--border-light)] bg-[var(--bg-surface)] shadow-2xl"
      style={{ left: pos.x, top: pos.y, width: size.width, height: size.height }}
    >
      {/* Header — drag anywhere on it to move the panel. */}
      <div
        onPointerDown={startMove}
        className="relative shrink-0 flex items-center justify-between px-3 h-9 cursor-grab active:cursor-grabbing select-none border-b border-[var(--border-light)]"
      >
        <div className="flex items-center gap-1.5 leading-none min-w-0">
          <span className="text-xs font-semibold text-[var(--text-primary)] shrink-0">Vibe</span>
          {surfaceLabel && (
            <span
              className="text-[11px] text-[var(--text-secondary)] truncate max-w-[180px]"
              title={surfaceLabel}
            >
              – {surfaceLabel}
            </span>
          )}
          {/* Accessory (credits indicator) is interactive — stop its
              pointerdown so grabbing it doesn't start a panel drag. */}
          {headerAccessory && (
            <span className="shrink-0" onPointerDown={(e) => e.stopPropagation()}>{headerAccessory}</span>
          )}
        </div>
        <button
          onClick={onClose}
          onPointerDown={(e) => e.stopPropagation()}
          title="Close"
          className="w-6 h-6 flex items-center justify-center bg-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer shrink-0"
          style={{ border: 'none' }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path fillRule="evenodd" clipRule="evenodd" d="M12 22c-4.714 0-7.071 0-8.536-1.465C2 19.072 2 16.714 2 12s0-7.071 1.464-8.536C4.93 2 7.286 2 12 2s7.071 0 8.535 1.464C22 4.93 22 7.286 22 12s0 7.071-1.465 8.535C19.072 22 16.714 22 12 22M8.97 8.97a.75.75 0 0 1 1.06 0L12 10.94l1.97-1.97a.75.75 0 0 1 1.06 1.06L13.06 12l1.97 1.97a.75.75 0 1 1-1.06 1.06L12 13.06l-1.97 1.97a.75.75 0 1 1-1.06-1.06L10.94 12l-1.97-1.97a.75.75 0 0 1 0-1.06" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 flex flex-col">{children}</div>

      {/* Bottom-right resize handle. */}
      <div
        onPointerDown={startResize}
        title="Resize"
        className="absolute bottom-0 right-0 w-4 h-4 flex items-end justify-end cursor-nwse-resize"
      >
        <svg width="9" height="9" viewBox="0 0 9 9" className="text-[var(--text-disabled)] mr-[3px] mb-[3px]">
          <path d="M8 1L1 8M8 5L5 8" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
        </svg>
      </div>
      {/* Whole-panel gate (header included) — the sheet's own ✕ is under
          the blur, so the gate renders a forwarding close. */}
      <VibeComingSoonGate onClose={onClose} />
    </motion.div>
  );
}
