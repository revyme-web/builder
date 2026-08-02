// ToolDivider.tsx — Horizontal separator between sections.
// Self-hides as first-child or last-child (so leading/trailing dividers don't
// leak through when the tools above/below return null), and collapses runs of
// consecutive dividers (when several conditional tools all return null) via
// the [data-tool-divider]+[data-tool-divider] CSS selector.

export default function ToolDivider() {
  return (
    <div
      data-tool-divider
      // A rule again, but doing less of the work than before. Pure whitespace
      // left the sections floating with nothing to bound them; the full-width
      // hairline was the strongest single tell against Framer. So: still a
      // hairline, but inset further from both edges (mx-5 vs mx-3) and sitting
      // in more space, so it reads as a light punctuation mark between groups
      // rather than as the ruled-list rhythm. The eyebrow title carries the
      // rest of the grouping.
      className="h-px bg-[var(--border-light)] mx-5 my-2 first:hidden last:hidden [[data-tool-divider]+&]:hidden"
    />
  );
}
