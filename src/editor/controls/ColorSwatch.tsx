// ColorSwatch — small inline color preview swatch.

import React from 'react';

export function ColorSwatch({ style, size = 'sm', className }: {
  style?: React.CSSProperties;
  size?: 'sm' | 'md'; // sm = w-5 h-5, md = w-7 h-7
  className?: string;
}) {
  const sizeClass = size === 'md' ? 'w-7 h-7' : 'w-5 h-5';
  return (
    <span
      className={`${sizeClass} rounded border border-white/10 flex-shrink-0${className ? ' ' + className : ''}`}
      style={style}
    />
  );
}

