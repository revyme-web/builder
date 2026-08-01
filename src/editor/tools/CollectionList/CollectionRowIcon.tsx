// CollectionRowIcon.tsx — the small colored icon-swatch shown on the Collection
// List rows (Filters / Sorting / Pagination). Master-aware: a FILLED row uses the
// theme accent — blue (`--accent`) on regular pages, purple (`--accent-secondary`)
// on component/master pages — while an EMPTY ("Add…") row shows a neutral swatch.

import { useAtomValue } from 'jotai';
import { isComponentFileAtom } from '@/code/stores/store';

export type RowGlyph = 'filter' | 'sort' | 'spinner';

// Clean inline glyphs (no external/iconify fetch needed).
const GLYPH: Record<RowGlyph, React.ReactNode> = {
  // Equalizer bars (the reference's filter glyph).
  filter: <path d="M6 19V11M12 19V5M18 19v-5" />,
  // Down arrow (sort).
  sort: <path d="M12 5v13M7 13l5 5 5-5" />,
  // Three-quarter loading arc (spinner).
  spinner: <path d="M21 12a9 9 0 1 1-6.219-8.56" />,
};

export default function CollectionRowIcon({ glyph, active }: { glyph: RowGlyph; active: boolean }) {
  const isMaster = useAtomValue(isComponentFileAtom);
  const bg = active
    ? (isMaster ? 'var(--accent-secondary, #a856b2)' : 'var(--accent, #e6b450)')
    : 'var(--grid-line)';
  const stroke = active ? '#ffffff' : 'var(--text-secondary)';
  return (
    <span
      className="flex items-center justify-center w-5 h-5 rounded border border-white/10 flex-shrink-0"
      style={{ backgroundColor: bg }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        {GLYPH[glyph]}
      </svg>
    </span>
  );
}
