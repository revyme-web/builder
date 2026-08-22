// ToolTextArea.tsx — Multi-line text input.

import { useState, useEffect } from 'react';
import { trace } from '@/shared/debug-trace';

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  mono?: boolean;
  disabled?: boolean;
}

export default function ToolTextArea({ value, onChange, placeholder, rows = 3, mono, disabled }: Props) {
  const [local, setLocal] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setLocal(value); }, [value, focused]);

  return (
    <textarea
      value={focused ? local : value}
      onChange={(e) => setLocal(e.target.value)}
      onFocus={() => { setFocused(true); setLocal(value); }}
      onBlur={() => { setFocused(false); if (local !== value) { trace.action('tool-textarea:commit', { changed: true }); onChange(local); } }}
      placeholder={placeholder}
      rows={rows}
      disabled={disabled}
      className={`w-full p-2 text-xs ${mono ? 'font-mono' : ''} bg-[var(--grid-line)] border border-[var(--control-border)] [--cut-border-color:var(--control-border)] hover:border-[var(--control-border-hover)] focus:border-[var(--border-focus)] text-[var(--text-primary)] cut-corners cut-border hover:[--cut-border-color:var(--control-border-hover)] focus:[--cut-border-color:var(--border-focus)] focus:outline-none transition-colors resize-none scrollbar-hide ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    />
  );
}
