// ToolSection.tsx — Collapsible section wrapper.
// Title row: mixed-case label on left, optional action button on right.
// Content: flex column with consistent spacing, reused by every tool.
// When hasContent=false (or collapsed): no bottom margin, no separator.

import React, { useState } from 'react';
import { trace } from '@/shared/debug-trace';

interface Props {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  collapsible?: boolean;
  /** Action button rendered on the right side of the title row */
  action?: React.ReactNode;
  /** When false, section renders compact with no bottom spacing/separator.
   *  Useful for sections like Animation/Layout that may have no entries. */
  hasContent?: boolean;
}

export default function ToolSection({ title, children, defaultOpen = true, collapsible = true, action, hasContent = true }: Props) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  const validChildren = React.Children.toArray(children).filter(Boolean);
  if (validChildren.length === 0) return null;

  const showContent = isOpen && hasContent;

  return (
    <div className="px-2">
      {/* Title row: label + action */}
      <div className={`${showContent ? 'mb-1.5' : 'mb-0'} flex items-center justify-between py-1.5`}>
        <span
          onClick={() => { if (collapsible) { setIsOpen(!isOpen); trace.action('tool-section:toggle', { title, isOpen: !isOpen }); } }}
          className={`text-xs font-bold text-[var(--text-primary)] ${collapsible ? 'cursor-pointer select-none' : ''} ${collapsible && !isOpen ? 'opacity-50' : ''}`}
        >
          {title}
        </span>
        {action}
      </div>
      {isOpen && showContent && (
        <div className="flex flex-col py-0.5 gap-2 pl-3">
          {children}
        </div>
      )}
    </div>
  );
}
