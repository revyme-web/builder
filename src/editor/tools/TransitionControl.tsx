// TransitionControl.tsx — Properties-panel control for a code-component
// `transition` control (`@controls` type "transition").
//
// A button showing the transition kind (Instant / Ease / Spring) that opens a
// ToolPopup wrapping the EXISTING Motion transition editor (`TransitionPanel`)
// — the same Instant/Ease/Spring editor with the curve preview + physics
// fields used by the animation system. The value is stored on the instance as
// a JSON-string prop (a framer-motion transition object); the code component
// `JSON.parse`s it.

import { useState, useRef, useMemo } from 'react';
import { ToolRow } from '../controls';
import ToolPopup from '../ui/ToolPopup';
import TransitionPanel from './AnimationTool/TransitionPanel';
import { TransitionCurveIcon, summarizeTransition } from './AnimationTool/CurvePreview';
import { trace } from '@/shared/debug-trace';

interface TransitionControlProps {
  label: string;
  /** Current value — a JSON string of the transition object. */
  value: string;
  /** Called with the new JSON string whenever the editor writes. */
  onChange: (jsonValue: string) => void;
}

/** Parse the JSON-string prop into the flat string-map TransitionPanel wants. */
function parseTransition(json: string): Record<string, string> {
  try {
    const obj = JSON.parse(json);
    if (obj && typeof obj === 'object') {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj)) out[k] = String(v);
      if (out.type) return out;
    }
  } catch { /* fall through to default */ }
  return { type: 'tween', duration: '0.45', ease: 'easeInOut', delay: '0' };
}

export default function TransitionControl({ label, value, onChange }: TransitionControlProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const transition = useMemo(() => parseTransition(value), [value]);

  trace.fn('TransitionControl:render', { label, type: transition.type, open });

  return (
    <ToolRow label={label}>
      <button
        ref={btnRef}
        onClick={() => setOpen(o => !o)}
        className="w-full h-[var(--control-height-sm)] px-2 flex items-center gap-1.5 text-xs cut-corners cut-border hover:[--cut-border-color:var(--control-border-hover)] bg-[var(--control-bg)] border border-[var(--control-border)] [--cut-border-color:var(--control-border)] hover:border-[var(--control-border-hover)] text-[var(--text-primary)] transition-colors"
      >
        {/* Reuse the EXACT same curve icon + summary as the Animation tool's
            Transition row, so the code component `transition` control reads identically. */}
        <TransitionCurveIcon isSpring={transition.type === 'spring'} />
        <span className="truncate flex-1 text-left">{summarizeTransition(transition)}</span>
      </button>

      <ToolPopup isOpen={open} onClose={() => setOpen(false)} title={label} anchorRef={btnRef} width={280}>
        {/* ToolPopup wraps children in `px-3 pb-3 pt-1` already — no extra
            padding wrapper, same as the normal popups. */}
        <TransitionPanel
          initialTransition={transition}
          onWrite={(t) => onChange(JSON.stringify(t))}
        />
      </ToolPopup>
    </ToolRow>
  );
}
