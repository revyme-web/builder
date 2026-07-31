// TypoTagBadge — the small "P" / "H1"…"H6" label shown next to a typography preset.
//
// Two looks, matching the reference:
//   • default → a compact bold glyph in a fixed-width column (used in the preset list, so names align).
//   • card    → a filled mini-card swatch (used in the applied "Preset"/"Styles" pill).
// Both are theme-aware: the card uses text-primary on a bg-panel-colored label so it stays a contrasting
// chip in light AND dark mode (never a hardcoded white box, and never white-on-white).

interface Props {
  /** Preset tag: 'p' | 'h1' … 'h6'. Defaults to paragraph. */
  tag?: string;
  /** Use the primary (brighter) text color — for the active list row. Ignored for the card variant. */
  active?: boolean;
  /** Render as a filled mini-card swatch (the applied-pill look). */
  card?: boolean;
}

export function TypoTagBadge({ tag = 'p', active, card }: Props) {
  const label = (tag || 'p').toUpperCase();
  if (card) {
    return (
      <span className="shrink-0 w-5 h-5 rounded-[5px] bg-[var(--text-primary)] text-[var(--bg-panel)] text-[9px] font-bold flex items-center justify-center leading-none select-none">
        {label}
      </span>
    );
  }
  return (
    <span
      className={`shrink-0 w-5 text-center text-[10px] font-bold leading-none select-none ${
        active ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'
      }`}
    >
      {label}
    </span>
  );
}

