// ValuePreview — renders a color swatch, text snippet, or asset thumbnail
// for a single preset token. Used in PresetRow.

import React from 'react';
import { useAtomValue } from 'jotai';
import type { PresetToken } from '@/shared/types';
import { parseBorderShorthand } from '@/editor/ui/border-utils';
import { livePresetTokenAtom } from '@/code/stores/preset-store';
import { extractAssetUrl } from '../shared/format-utils';

export function ValuePreview({ token }: { token: PresetToken }) {
  // Live override while this color preset is being dragged in its edit popup —
  // shows the in-progress value before it commits to presetTokensAtom.
  const livePreset = useAtomValue(livePresetTokenAtom);
  if (token.category === 'color') {
    const color = livePreset?.name === token.name ? livePreset.value : token.value;
    return (
      <div
        className="w-3.5 h-3.5 rounded-sm border border-[var(--border-light)] flex-shrink-0"
        style={{ backgroundColor: color }}
      />
    );
  }
  if (token.category === 'image') {
    const url = extractAssetUrl(token.value);
    return url ? (
      <div
        className="w-3.5 h-3.5 rounded-sm border border-[var(--border-light)] flex-shrink-0 bg-[var(--grid-line)]"
        style={{ backgroundImage: `url(${url})`, backgroundSize: 'cover', backgroundPosition: 'center' }}
      />
    ) : (
      <div className="w-3.5 h-3.5 rounded-sm border border-[var(--border-light)] bg-[var(--bg-secondary)] flex-shrink-0" />
    );
  }
  if (token.category === 'video') {
    const url = extractAssetUrl(token.value);
    return (
      <div className="w-3.5 h-3.5 rounded-sm border border-[var(--border-light)] flex-shrink-0 bg-black overflow-hidden flex items-center justify-center">
        {url ? (
          <svg width="8" height="8" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21" /></svg>
        ) : null}
      </div>
    );
  }
  if (token.category === 'typography') {
    return (
      <div
        className="w-3.5 h-3.5 flex items-center justify-center flex-shrink-0"
        style={{ color: 'var(--text-primary)', fontSize: '10px', fontWeight: 400, lineHeight: 1 }}
      >
        Aa
      </div>
    );
  }
  if (token.category === 'radius') {
    return (
      <div
        className="w-3.5 h-3.5 border-2 border-[var(--text-secondary)] flex-shrink-0"
        style={{ borderRadius: token.value }}
      />
    );
  }
  if (token.category === 'shadow') {
    return (
      <div
        className="w-3.5 h-3.5 rounded-sm border border-[var(--border-light)] flex-shrink-0"
        style={{ backgroundColor: 'rgba(0,0,0,0.2)' }}
      />
    );
  }
  if (token.category === 'spacing') {
    return (
      <div className="w-3.5 h-3.5 border border-[var(--text-secondary)] rounded-sm relative flex-shrink-0">
        <div className="absolute inset-1 bg-[var(--text-secondary)] opacity-20" />
      </div>
    );
  }
  if (token.category === 'margin') {
    return (
      <div className="w-3.5 h-3.5 relative flex-shrink-0">
        <div className="absolute inset-0 border border-dashed border-[var(--text-secondary)] rounded-sm" />
        <div className="absolute inset-1 border border-[var(--text-secondary)] rounded-sm" />
      </div>
    );
  }
  if (token.category === 'border') {
    // Render the actual border style so each row gives a quick visual hint
    // (dashed/dotted, color, width).
    const side = parseBorderShorthand(token.value);
    return (
      <div
        className="w-3.5 h-3.5 rounded-sm flex-shrink-0"
        style={{
          borderWidth: side.width ? `${Math.min(side.width, 3)}px` : '1px',
          borderStyle: side.width ? side.style : 'solid',
          borderColor: side.width ? side.color : 'var(--text-secondary)',
        }}
      />
    );
  }
  return (
    <div className="w-3.5 h-3.5 rounded-sm border border-[var(--border-light)] bg-[var(--bg-secondary)] flex-shrink-0" />
  );
}
