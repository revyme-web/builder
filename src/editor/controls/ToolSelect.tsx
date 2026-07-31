// ToolSelect.tsx — Styled dropdown. No label — use ToolRow for that.
// Exact styling from old builder's ToolSelect.tsx.

import { trace } from '@/shared/debug-trace';

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
  className?: string;
  /** Disable the whole control (e.g. a primary-only field on a replica). */
  disabled?: boolean;
}

export default function ToolSelect({ value, onChange, options, className, disabled }: Props) {
  return (
    <div className={`relative w-full ${className || ''}`}>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => { trace.action('tool-select:change', { from: value, to: e.target.value }); onChange(e.target.value); }}
        className={`w-full h-8 pl-2 pr-6 text-xs appearance-none bg-[var(--grid-line)] border border-[var(--control-border)] text-[var(--text-primary)] rounded-[var(--radius-lg)] focus:outline-none transition-colors ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:border-[var(--control-border-hover)] focus:border-[var(--border-focus)] cursor-pointer'}`}
      >
        {options.map(opt => (
          <option key={opt.value} value={opt.value} disabled={opt.disabled}>{opt.label}</option>
        ))}
      </select>
      <svg
        className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none"
        width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </div>
  );
}
