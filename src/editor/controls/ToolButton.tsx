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
      className={`h-[var(--control-height-sm)] w-full flex items-center justify-center text-xs bg-[var(--grid-line)] border border-[var(--control-border)] hover:border-[var(--control-border-hover)] focus:border-[var(--border-focus)] text-[var(--text-primary)] cut-corners cut-border hover:[--cut-border-color:var(--control-border-hover)] focus:[--cut-border-color:var(--border-focus)] focus:outline-none transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${className || ''}`}
    >
      {children}
    </button>
  );
}
