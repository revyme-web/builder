// SearchBar.tsx — Reusable search input with a leading magnifier icon.
//
// Ported from the inline `SearchBar` previously living in IconPanel.tsx
// so left-panel sections that want a search row (Pages, Layers, Library,
// Insert) all share the same shape: w-full pill, tinted bg that brightens
// on hover/focus, 14×14 magnifier inset at the left. No clear button on
// purpose — the value lives in the caller's state, and adding a × meant
// every consumer had to wire one up. Callers that want a clear affordance
// can render their own button next to the bar.

import { useRef, useEffect } from 'react';

interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Focus the input on mount. Useful when the panel opens with the
   *  bar visible and the user's cursor is already aimed at it. */
  autoFocus?: boolean;
  className?: string;
}

export default function SearchBar({ value, onChange, placeholder = 'Search…', autoFocus, className = '' }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);
  return (
    <div className={`relative ${className}`}>
      <svg
        className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-secondary)] pointer-events-none"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="11" cy="11" r="7" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      {/* Tinted fill so the bar reads as a clearly tappable affordance.
          Theme-mirrored: a black tint on the light panel, a white tint on
          the dark one — the prior white-only tier was invisible in light
          mode (white on a white panel). Brightens on hover/focus. */}
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full pl-8 pr-2 py-1.5 text-xs bg-black/[0.06] hover:bg-black/[0.09] focus:bg-black/[0.12] dark:bg-white/[0.1] dark:hover:bg-white/[0.14] dark:focus:bg-white/[0.18] cut-corners text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] outline-none transition-colors"
      />
    </div>
  );
}
