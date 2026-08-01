// CreditsIndicator.tsx — compact "X credits" pill for the AI chat bars.
//
// Reads the workspace credit balance from `credits-store`. Clicking it
// opens the workspace credits page (revyme-cloud settings) in a new
// tab. Renders nothing when credits are unavailable — standalone/local
// mode, or before the balance has loaded — so the AI bars degrade
// cleanly with no layout placeholder.

import { useCredits, openWorkspaceCreditsPage } from '@/code/stores/credits-store';

/** Compact credit count: 1234 → "1,234", 12500 → "12.5k". */
function formatCredits(n: number): string {
  if (n < 10_000) return n.toLocaleString();
  return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
}

export default function CreditsIndicator() {
  const credits = useCredits();
  if (!credits) return null;


  // Rendered as a header accessory next to a title ("AI", "AI Chat"),
  // so it carries its own leading dash separator. When there are no
  // credits the whole thing (dash included) is gone — see the early
  // return above — so the title never shows a dangling "– ".
  return (
    <span className="inline-flex items-center gap-1.5 leading-none whitespace-nowrap">
      <span className="text-xs text-[var(--text-disabled)]">–</span>
      <button
        type="button"
        onClick={openWorkspaceCreditsPage}
        title="View workspace credits"
        className="bg-transparent text-xs leading-none font-medium text-[var(--accent-text)] hover:brightness-125 transition cursor-pointer"
        style={{ border: 'none', padding: 0 }}
      >
        {formatCredits(credits.balance)} credits
      </button>
    </span>
  );
}
