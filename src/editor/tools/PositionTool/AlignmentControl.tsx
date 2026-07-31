// AlignmentControl.tsx — 6 alignment icon buttons matching old builder exactly.
// Icons: AlignLeft, AlignHCenter, AlignRight, AlignTop, AlignVCenter, AlignBottom
// Color: accent blue when enabled, disabled gray when not alignable.

import { useCallback } from 'react';
import { calculateAlignment, type AlignDirection } from '@/shared/pin-utils';
import { trace } from '@/shared/debug-trace';

// ─── Alignment Icons (exact SVGs from old builder) ──────────────────────

const AlignLeft = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" className={className}>
    <g fill="none" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 22V2" />
      <path fill="currentColor" d="M19 16H9a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2Z" />
    </g>
  </svg>
);

const AlignHCenter = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" className={className}>
    <g fill="none" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 22V2" />
      <path fill="currentColor" d="M19 16H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2Z" />
    </g>
  </svg>
);

const AlignRight = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" className={className}>
    <g fill="none" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 22V2" />
      <path fill="currentColor" d="M15 16H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2Z" />
    </g>
  </svg>
);

const AlignTop = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" className={className}>
    <g fill="none" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M22 3H2" />
      <path fill="currentColor" d="M8 19V9a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2Z" />
    </g>
  </svg>
);

const AlignVCenter = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" className={className}>
    <g fill="none" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M22 12H2" />
      <path fill="currentColor" d="M8 19V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2Z" />
    </g>
  </svg>
);

const AlignBottom = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" className={className}>
    <g fill="none" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M22 21H2" />
      <path fill="currentColor" d="M8 15V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2Z" />
    </g>
  </svg>
);

// ─── Component ──────────────────────────────────────────────────────────

interface Props {
  nodeId: string;
  enabled: boolean;
  /** The node's current styles — the aligner inspects pin state
   *  (left/right/top/bottom px) + transform to pick the right math. */
  styles: Record<string, string>;
  onUpdate: (styles: Record<string, string>) => void;
  getElementRect: () => { width: number; height: number } | null;
  getParentRect: () => { width: number; height: number } | null;
}

const BUTTONS: { dir: AlignDirection; Icon: React.FC<{ className?: string }>; title: string }[] = [
  { dir: 'left', Icon: AlignLeft, title: 'Align Left' },
  { dir: 'center-h', Icon: AlignHCenter, title: 'Center Horizontally' },
  { dir: 'right', Icon: AlignRight, title: 'Align Right' },
  { dir: 'top', Icon: AlignTop, title: 'Align Top' },
  { dir: 'center-v', Icon: AlignVCenter, title: 'Center Vertically' },
  { dir: 'bottom', Icon: AlignBottom, title: 'Align Bottom' },
];

// Presentational button bar — shared by single-node AlignmentControl and the
// multi-select MultiAlignmentControl. Keeps the 6 icon SVGs in one place so the
// two aligners can't drift visually. The caller supplies the alignment math.
export function AlignmentButtons({ enabled, onAlign }: { enabled: boolean; onAlign: (dir: AlignDirection) => void }) {
  return (
    <div className="flex items-center justify-between w-full py-2">
      {BUTTONS.map(({ dir, Icon, title }) => (
        <button
          key={dir}
          onClick={() => enabled && onAlign(dir)}
          disabled={!enabled}
          title={title}
          className={`rounded transition-colors ${enabled
            ? 'hover:bg-[var(--bg-hover)] cursor-pointer'
            : 'cursor-not-allowed opacity-30'
          }`}
        >
          <Icon className={`w-4 h-4 ${enabled ? 'text-[var(--accent)]' : 'text-[var(--text-disabled)]'}`} />
        </button>
      ))}
    </div>
  );
}

export default function AlignmentControl({ enabled, styles, onUpdate, getElementRect, getParentRect }: Props) {
  const handleAlign = useCallback((dir: AlignDirection) => {
    if (!enabled) return;
    const elemRect = getElementRect();
    const parentRect = getParentRect();
    if (!elemRect || !parentRect) return;
    const update = calculateAlignment(dir, styles, elemRect, parentRect);
    trace.action('alignment:apply', { dir, update });
    onUpdate(update);
  }, [enabled, styles, onUpdate, getElementRect, getParentRect]);

  return <AlignmentButtons enabled={enabled} onAlign={handleAlign} />;
}
