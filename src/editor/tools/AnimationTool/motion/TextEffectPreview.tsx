// TextEffectPreview.tsx — Live preview showing "Smooth" animating with the current config.
//
// Renders the REAL `<RevymeSplitText>` from @revyme/runtime — the same component the published
// site runs. It used to reimplement the split, the hidden/visible states and the transition
// here, which meant the popup could (and did) disagree with what shipped. Now the only preview-
// specific behaviour is the replay key and forcing `trigger: 'view'`: the popup has no scroll
// container, so a scroll-mode config would otherwise sit frozen at its start value.

import { useState, useEffect } from 'react';
import { RevymeSplitText } from '@revyme/runtime';
import type { TextAnimConfig } from './text-anim-presets';
import { trace } from '@/shared/debug-trace';

const PREVIEW_TEXT = 'Smooth';

export default function TextEffectPreview({ config }: { config: TextAnimConfig }) {
  const [replayKey, setReplayKey] = useState(0);

  // Remount on any value change so the reveal replays.
  useEffect(() => {
    setReplayKey(k => k + 1);
    trace.action('text-effect-preview:replay', { animationType: config.animationType });
  }, [
    config.animationType, config.mask, config.opacity, config.scale, config.blur,
    config.rotateX, config.rotateY, config.rotateZ,
    config.skewX, config.skewY, config.x, config.y, config.delay,
    config.transition?.type, config.transition?.stiffness, config.transition?.damping,
    config.transition?.duration, config.transition?.ease, config.transition?.bounce,
  ]);

  return (
    <div className="w-full rounded-[var(--radius-md)] border border-[var(--control-border)] overflow-hidden bg-[var(--grid-line)] flex items-center justify-center"
      style={{ height: 64, perspective: 600 }}
    >
      <span style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: 1 }}>
        <RevymeSplitText
          key={replayKey}
          spec={{ ...config, trigger: 'view', responsive: undefined }}
        >{PREVIEW_TEXT}</RevymeSplitText>
      </span>
    </div>
  );
}
