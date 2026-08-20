// Breadcrumb.tsx — Reusable breadcrumb navigation with pill-style segments.
// Used by: ComponentBreadcrumb (DynamicToolbar), ComponentEditorOverlay header.
// Each segment is a rounded pill with optional icon. Last segment is non-interactive.

import React, { type ReactNode } from 'react';

export interface BreadcrumbSegment {
  label: string;
  icon?: ReactNode;
  /** Accent color for text+icon. Defaults to var(--text-secondary) */
  color?: string;
  /** Small indicator dot after label (e.g. unsaved changes) */
  dot?: boolean;
  /** Click handler. If omitted (or last segment), segment is non-interactive. */
  onClick?: () => void;
}

interface BreadcrumbProps {
  segments: BreadcrumbSegment[];
}

function Chevron() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 text-[var(--text-tertiary)]">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

export default function Breadcrumb({ segments }: BreadcrumbProps) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        const isClickable = !!seg.onClick && !isLast;
        const color = seg.color ?? 'var(--text-secondary)';

        return (
          <React.Fragment key={i}>
            {i > 0 && <Chevron />}
            <button
              onClick={isClickable ? seg.onClick : undefined}
              className={`flex items-center gap-1.5 px-2 h-[30px] bg-[var(--button-secondary-bg,rgba(255,255,255,0.06))] cut-corners text-xs font-medium transition-all max-w-[250px] whitespace-nowrap ${
                isClickable ? 'hover:brightness-125 cursor-pointer' : 'cursor-default'
              }`}
              style={{ color }}
            >
              {seg.icon && <span className="flex-shrink-0 flex items-center">{seg.icon}</span>}
              <span className="truncate">{seg.label}</span>
              {seg.dot && <span className="w-1.5 h-1.5 rounded-full ml-0.5 flex-shrink-0" style={{ backgroundColor: color }} />}
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
}
