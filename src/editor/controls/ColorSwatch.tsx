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
      // Shell: the clip + the straight 1px rect border. The pin is a literal
      // because this swatch's hairline is border-white/10, not a token.
      className={`${sizeClass} relative [--cut-border-color:rgba(255,255,255,0.1)] border border-white/10 flex-shrink-0 flex items-center justify-center${className ? ' ' + className : ''}`}
    >
      {/* LAYER 1 — the fill, on its own element (never on the shell): a
        * background shorthand on the shell replaced .cut-border's gradient
        * stack and inherited its no-repeat, collapsing the checkerboard to one
        * tile (2026-09-08). */}
      {style && <span aria-hidden className="absolute inset-0 pointer-events-none" style={style} />}
      {/* LAYER 2 — the diagonal corner strokes the clip removes (.cut-border),
        * painted ABOVE the fill. On the shell they are a background image, and
        * a fill layer covers a background — the cut corners lost their hairline
        * and the swatch read as an unclipped square (2026-09-09). `-inset-px`
        * spans the shell's BORDER box (clip-path and .cut-border both resolve
        * against it); `--cut` is inherited from the shell's size class. */}
      <span aria-hidden className="absolute -inset-px pointer-events-none cut-border" />
      {children != null && <span className="relative flex items-center justify-center">{children}</span>}
    </span>
  );
}
