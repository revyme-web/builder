// ToolPlusMinus.tsx — Plus/minus stepper buttons.

import { trace } from '@/shared/debug-trace';

interface Props {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}

export default function ToolPlusMinus({ value, onChange, min = 0, max = 10000, step = 1 }: Props) {
  return (
    <div className="flex w-full items-center border border-[var(--control-border)] rounded-md overflow-hidden">
      <button
        onClick={() => { const v = Math.max(min, value - step); trace.action('tool-plus-minus:decrement', { from: value, to: v }); onChange(v); }}
        className="flex-1 flex items-center justify-center h-[var(--control-height-sm)] transition-colors bg-[var(--choice-bg)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--control-bg-hover)]"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12" /></svg>
      </button>
      <button
        onClick={() => { const v = Math.min(max, value + step); trace.action('tool-plus-minus:increment', { from: value, to: v }); onChange(v); }}
        className="flex-1 flex items-center justify-center h-[var(--control-height-sm)] transition-colors bg-[var(--choice-bg)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--control-bg-hover)]"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
      </button>
    </div>
  );
}
