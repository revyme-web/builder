// ToolSwitch.tsx — Toggle switch (on/off).

import { trace } from '@/shared/debug-trace';

interface Props {
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}

export default function ToolSwitch({ value, onChange, disabled }: Props) {
  return (
    <button
      onClick={() => { if (!disabled) { trace.action('tool-switch:toggle', { from: value, to: !value }); onChange(!value); } }}
      disabled={disabled}
      className={`relative inline-flex h-5 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out disabled:cursor-not-allowed disabled:opacity-50 ${value ? 'bg-[var(--accent)]' : 'bg-[var(--control-border)]'}`}
    >
      <span
        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${value ? 'translate-x-5' : 'translate-x-0'}`}
      />
    </button>
  );
}
