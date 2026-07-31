// ControlActionRow — reusable popup row button with consistent styling.
// Replaces 17+ duplicated className strings across tool panels.

import React from 'react';

interface ControlActionRowProps {
  onClick?: (e: React.MouseEvent) => void;
  children: React.ReactNode;
  /** Use centered h-8 px-3 text-center variant (e.g. TextStyleTool rows) */
  center?: boolean;
  /** Extra Tailwind classes (e.g. 'justify-between') */
  className?: string;
  /** Pass-through for any data-* attributes (e.g. data-scroll-transform-entry) */
  [key: `data-${string}`]: string | undefined;
}

const BASE =
  // `min-w-0` is REQUIRED: this is a flex item AND a <button>, whose automatic min-width is its full content
  // (its `truncate` text has white-space:nowrap → min-content = the whole label). Without min-w-0 the button
  // can't shrink below its text, so in a flex ROW (e.g. InteractionsTool's "Click → Set X") it sizes to content
  // and the pills come out ragged. With it, a `w-full` button shrinks to fill its column AND truncates.
  'w-full min-w-0 h-8 flex items-center gap-2 bg-[var(--grid-line)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] rounded-[var(--radius-lg)] cursor-pointer transition-colors text-xs text-[var(--text-primary)]';

export function ControlActionRow({ onClick, children, center, className, ...rest }: ControlActionRowProps) {
  // Extract only data-* attributes from rest
  const dataAttrs: Record<string, string | undefined> = {};
  for (const key of Object.keys(rest)) {
    if (key.startsWith('data-')) {
      dataAttrs[key] = (rest as Record<string, string | undefined>)[key];
    }
  }

  const paddingClass = center ? 'px-3 justify-center text-center' : 'px-1';

  return (
    <button
      type="button"
      onClick={onClick}
      className={`${BASE} ${paddingClass}${className ? ' ' + className : ''}`}
      {...dataAttrs}
    >
      {children}
    </button>
  );
}

