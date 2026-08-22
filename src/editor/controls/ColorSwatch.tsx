// ColorSwatch — small inline color preview swatch.

import React from 'react';

export function ColorSwatch({ style, size = 'sm', className, children }: {
  style?: React.CSSProperties;
  size?: 'sm' | 'md'; // sm = w-5 h-5, md = w-7 h-7
  className?: string;
  /** Optional glyph centred on the fill — used by the swatches that carry an
   *  icon (interaction rows, CMS row icons, the video preset tile). Before this
   *  existed those sites hand-rolled the whole swatch, and one of them said so
   *  in a comment; the copies then missed styling changes made here. */
  children?: React.ReactNode;
}) {
  // Cut tier follows the size so the slice stays proportional: 4px of a 20px
  // chip and 6px of a 28px one are both ~20% of the edge. One tier for both
  // would read as a heavier corner on the small swatch than on the large.
  const sizeClass = size === 'md' ? 'w-7 h-7 cut-corners' : 'w-5 h-5 cut-corners cut-sm';
  return (
    <span
      // cut-border paints the diagonal segments the clip removes; the pin is a
      // literal because this swatch's hairline is border-white/10, not a token.
      className={`${sizeClass} cut-border [--cut-border-color:rgba(255,255,255,0.1)] border border-white/10 flex-shrink-0 flex items-center justify-center${className ? ' ' + className : ''}`}
      style={style}
    >
      {children}
    </span>
  );
}

