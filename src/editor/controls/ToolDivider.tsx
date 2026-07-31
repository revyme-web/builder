// ToolDivider.tsx — Horizontal separator between sections.
// Self-hides as first-child or last-child (so leading/trailing dividers don't
// leak through when the tools above/below return null), and collapses runs of
// consecutive dividers (when several conditional tools all return null) via
// the [data-tool-divider]+[data-tool-divider] CSS selector.

export default function ToolDivider() {
  return (
    <div
      data-tool-divider
      className="h-px bg-[var(--border-light)] mx-3 my-2.5 first:hidden last:hidden [[data-tool-divider]+&]:hidden"
    />
  );
}
