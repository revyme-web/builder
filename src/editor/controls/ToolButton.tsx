// ToolButton.tsx — Standard toolbar button.

interface Props {
  children: React.ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  disabled?: boolean;
  className?: string;
}

export default function ToolButton({ children, onClick, disabled, className }: Props) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`h-7 w-full flex items-center justify-center text-xs bg-[var(--grid-line)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] focus:border-[var(--border-focus)] text-[var(--text-primary)] rounded-[var(--radius-lg)] focus:outline-none transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${className || ''}`}
    >
      {children}
    </button>
  );
}
