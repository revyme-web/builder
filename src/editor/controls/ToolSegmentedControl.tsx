// ToolSegmentedControl.tsx — Button group with animated highlight.

import { useRef, useEffect, useState } from 'react';
import { trace } from '@/shared/debug-trace';

interface Option {
  value: string;
  label?: string;
  icon?: React.ReactNode;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  size?: 'sm' | 'md' | 'compact';
}

export default function ToolSegmentedControl({ value, onChange, options, size = 'md' }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [highlight, setHighlight] = useState({ left: 0, width: 0 });
  const hasMounted = useRef(false);

  // Animate highlight to active button position (skip transition on first mount)
  useEffect(() => {
    if (!containerRef.current) return;
    const idx = options.findIndex(o => o.value === value);
    if (idx === -1) return;
    const buttons = containerRef.current.querySelectorAll('button');
    const btn = buttons[idx] as HTMLElement;
    if (btn) {
      setHighlight({ left: btn.offsetLeft, width: btn.offsetWidth });
    }
    // Enable transition only after first position is set
    if (!hasMounted.current) {
      requestAnimationFrame(() => { hasMounted.current = true; });
    }
  }, [value, options]);

  const py = size === 'compact' ? 'py-1' : size === 'sm' ? 'py-1.5' : 'py-2';
  const px = size === 'compact' ? 'px-1' : 'px-3';

  return (
    // Outlined like the inputs and selects: the track was a bare fill with no
    // border, so when the other controls moved to outlined-and-recessed this
    // one stayed a filled slab and stood out as the odd control.
    <div ref={containerRef} className="relative flex w-full bg-[var(--choice-bg)] border border-[var(--control-border)] rounded-[var(--radius-lg)] p-0.5">
      {/* Animated highlight */}
      <div
        className="absolute rounded"
        style={{
          left: highlight.left,
          width: highlight.width,
          top: 2, bottom: 2,
          backgroundColor: 'var(--segmented-bg)',
          // The track is close to the panel now, so the thumb carries the
          // "raised" reading on its own. Matters most on light, where the
          // thumb is white on a near-white track.
          boxShadow: '0 1px 2px rgba(0, 0, 0, 0.18)',
          transition: hasMounted.current ? 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)' : 'none',
          zIndex: 1,
        }}
      />
      {options.map(opt => (
        <button
          key={opt.value}
          onClick={() => { trace.action('tool-segmented:change', { from: value, to: opt.value }); onChange(opt.value); }}
          className={`flex-1 flex items-center justify-center gap-2 text-xs ${py} ${px} rounded transition-colors relative z-10 ${value === opt.value ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
        >
          {opt.icon}
          {opt.label && <span>{opt.label}</span>}
        </button>
      ))}
    </div>
  );
}
