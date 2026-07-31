// SectionLabel.tsx — Reusable section header label for sidebar panels.
// Used for: "Components", "Typography", "Color", "Pages", etc.
// Sizes: xl (panel title), md (section header), sm (sub-section), xs (category).

import type { ReactNode } from 'react';

type SectionLabelSize = 'xl' | 'md' | 'sm' | 'xs';

interface SectionLabelProps {
  children: ReactNode;
  size?: SectionLabelSize;
  /** Optional right-side content (+ button, info icon, etc.) */
  right?: ReactNode;
  className?: string;
}

const SIZE_CLASSES: Record<SectionLabelSize, string> = {
  xl: 'text-sm font-medium text-[var(--text-primary)]',
  md: 'text-xs font-semibold text-[var(--text-secondary)]',
  sm: 'text-[11px] font-semibold text-[var(--text-secondary)]',
  xs: 'text-[10px] font-extrabold text-[var(--text-secondary)] tracking-wider uppercase',
};

export default function SectionLabel({ children, size = 'md', right, className = '' }: SectionLabelProps) {
  return (
    <div className={`px-3 pt-3 pb-1.5 flex items-center justify-between ${className}`}>
      <span className={SIZE_CLASSES[size]}>{children}</span>
      {right}
    </div>
  );
}
