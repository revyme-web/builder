// ExportDropdown.tsx — mirrors LiveDropdown's UX for the Export button.
//
// Click Export → this drops below the button with a list of format
// options (Source, Tailwind) and a primary "Export project" button at
// the bottom. Source is free for everyone; Tailwind is Pro-gated and
// shows an upgrade nudge for free / lite users instead of running.
//
// Selecting a format only changes a local pointer — nothing fires
// until the user clicks the primary button. The button label flips to
// "Upgrade to export in Tailwind" when the selected format requires a
// plan the user doesn't have, and clicking it opens Plans instead of
// triggering a download.

import { useEffect, useRef, type ReactNode } from 'react';
import { CLOUD_ENABLED } from '@/shared/cloud-flag';
import { motion, AnimatePresence } from 'framer-motion';
import type { WebsiteMeta } from '@/backend/types';

// ─── Brand icons ────────────────────────────────────────────────────────────
//
// Hand-rolled small versions of the Next.js + Tailwind marks. Kept
// inline so the dropdown doesn't pull a brand-icon package for two
// glyphs. The Next.js icon adapts to the surface (white-on-dark by
// using `currentColor` for the N and a subtle circle outline). The
// Tailwind mark keeps its signature cyan so it reads as the brand
// even at 16px.

function NextLogo({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 180 180"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <mask
        id="ndmask"
        style={{ maskType: 'alpha' }}
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width="180"
        height="180"
      >
        <circle cx="90" cy="90" r="90" fill="black" />
      </mask>
      <g mask="url(#ndmask)">
        <circle cx="90" cy="90" r="90" fill="currentColor" />
        <path
          d="M149.508 157.52 69.142 54H54v71.97h12.114V69.39l73.885 95.455a90 90 0 0 0 9.509-7.325"
          fill="url(#ndg1)"
        />
        <path fill="url(#ndg2)" d="M115 54h12v72h-12z" />
      </g>
      <defs>
        <linearGradient id="ndg1" x1="109" y1="116.5" x2="144.5" y2="160.5" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--bg-surface, #fff)" />
          <stop offset="1" stopColor="var(--bg-surface, #fff)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="ndg2" x1="121" y1="54" x2="120.799" y2="106.875" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--bg-surface, #fff)" />
          <stop offset="1" stopColor="var(--bg-surface, #fff)" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function TailwindLogo({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={(size * 32.4) / 54}
      viewBox="0 0 54 33"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path
        d="M27 0c-7.2 0-11.7 3.6-13.5 10.8 2.7-3.6 5.85-4.95 9.45-4.05 2.054.513 3.522 2.004 5.147 3.653C30.744 13.09 33.808 16.2 40.5 16.2c7.2 0 11.7-3.6 13.5-10.8-2.7 3.6-5.85 4.95-9.45 4.05-2.054-.513-3.522-2.004-5.147-3.653C36.756 3.11 33.692 0 27 0zM13.5 16.2C6.3 16.2 1.8 19.8 0 27c2.7-3.6 5.85-4.95 9.45-4.05 2.054.514 3.522 2.004 5.147 3.653C17.244 29.29 20.308 32.4 27 32.4c7.2 0 11.7-3.6 13.5-10.8-2.7 3.6-5.85 4.95-9.45 4.05-2.054-.513-3.522-2.004-5.147-3.653C23.256 19.31 20.192 16.2 13.5 16.2z"
        fill="#38bdf8"
      />
    </svg>
  );
}

// ─── Format catalogue ───────────────────────────────────────────────────────

export type ExportFormat = 'source' | 'tailwind';

interface FormatDef {
  id: ExportFormat;
  label: string;
  /** One-line subtitle rendered under the format name. */
  sublabel: string;
  /** Plan tier required to use this format. 'free' = available to all. */
  minPlan: 'free' | 'pro';
  /** Brand glyph rendered on the left of the row, in place of the
   *  prior generic checkmark dot. */
  icon: ReactNode;
}

const FORMATS: FormatDef[] = [
  {
    id: 'source',
    label: 'Source code',
    sublabel: 'Full Next.js project',
    minPlan: 'free',
    icon: <NextLogo size={18} />,
  },
  {
    id: 'tailwind',
    label: 'Tailwind',
    sublabel: 'Next.js with Tailwind',
    minPlan: 'pro',
    icon: <TailwindLogo size={18} />,
  },
];

// ─── Plan helper ────────────────────────────────────────────────────────────

const PLAN_RANK: Record<string, number> = {
  free: 0,
  lite: 1,
  pro: 2,
  studio: 3,
};

function meetsPlan(meta: WebsiteMeta | null, required: 'free' | 'pro'): boolean {
  // Standalone/OSS mode has no plans — every export format is available.
  if (!CLOUD_ENABLED) return true;
  // Free is always available.
  if (required === 'free') return true;
  if (!meta) return false;
  const plan = (meta.plan ?? 'free').toLowerCase();
  // Paid plans with non-active subscriptions (past_due, canceled, etc.)
  // revert to free-tier feature gating — same rule the backend's
  // `effectivePlan` uses.
  if (plan !== 'free' && meta.planStatus && meta.planStatus !== 'active') {
    return false;
  }
  return (PLAN_RANK[plan] ?? 0) >= (PLAN_RANK[required] ?? 0);
}

// ─── Props ──────────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  meta: WebsiteMeta | null;
  /** Currently-chosen format. Parent owns the state so it persists
   *  across opens. */
  format: ExportFormat;
  onFormatChange: (next: ExportFormat) => void;
  exporting: boolean;
  /** Fires when the primary button is the "Export project" action.
   *  Parent runs the fetch + download using the active `format`. */
  onExport: () => void;
  /** Fires when the primary button is the "Upgrade" action.
   *  Parent opens the Plans settings tab. */
  onUpgrade: () => void;
  onClose: () => void;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function ExportDropdown({
  open, meta, format, onFormatChange, exporting, onExport, onUpgrade, onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Outside-click close — skip clicks on the Export button itself
  // (data-export-trigger) so its own toggle handler wins cleanly,
  // same trick LiveDropdown uses.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (ref.current && !ref.current.contains(target) && !target.closest('[data-export-trigger]')) {
        onClose();
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open, onClose]);

  const selected = FORMATS.find(f => f.id === format) ?? FORMATS[0]!;
  const canUseSelected = meetsPlan(meta, selected.minPlan);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={ref}
          onClick={(e) => e.stopPropagation()}
          initial={{ opacity: 0, scale: 0.95, y: -10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: -10 }}
          transition={{ type: 'spring', stiffness: 400, damping: 22, mass: 0.8 }}
          className="absolute top-full mt-6 right-0 bg-[var(--dropdown-bg)] shadow-[var(--shadow-lg)] cut-corners cut-lg cut-border [--cut-border-color:var(--border-light)] border border-[var(--border-light)] p-3 z-[10001] min-w-[230px]"
        >
          {/* Format list. Locked options stay visible + clickable —
              clicking them just selects (so the primary button flips
              to Upgrade). Matches the way Plans-style upsell rows
              behave elsewhere in the editor: no hidden options, just
              a clear "you'd need to upgrade" signal.
              The outer motion.div now uses `p-2` (vs LiveDropdown's
              `py-2`) so the inner rows sit ~4px further from the
              rounded chrome on each side — the publish dropdown's
              visual rhythm at narrower widths felt more "squished",
              and adding the horizontal pad here matches that feel
              regardless of `min-w-[260px]`. */}
          <div className="flex flex-col gap-1">
            {FORMATS.map((f) => {
              const isActive = f.id === format;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => onFormatChange(f.id)}
                  className={`group flex items-center gap-2 px-2 py-2 cut-corners text-left cursor-pointer transition-colors ${
                    isActive
                      ? 'bg-black/[0.06] dark:bg-white/[0.08]'
                      : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.04]'
                  }`}
                >
                  {/* Brand glyph (Next.js / Tailwind). Active state is
                      conveyed by the row's bg highlight — no separate
                      checkmark needed, the icon is recognizable enough. */}
                  <span className="shrink-0 flex items-center justify-center w-[18px] h-[18px] text-[var(--text-primary)]">
                    {f.icon}
                  </span>
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-medium text-[var(--text-primary)] truncate block">
                      {f.label}
                    </span>
                    {/* Sublabel — bumped from `--text-tertiary` (too dim
                        in dark mode) to `--text-secondary`, the same
                        muted tier LiveDropdown uses for its meta rows. */}
                    <div className="text-[10px] text-[var(--text-secondary)] truncate">
                      {f.sublabel}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Divider — the outer `p-2` already provides the horizontal
              inset, so this just needs vertical margin to space it
              between the format list and the primary button block. */}
          <div className="h-[1px] bg-white/10 my-1" />

          {/* Primary button — Export OR Upgrade based on whether the
              selected format is locked behind a plan the user doesn't
              have. Geometry, radius, gap all copied from LiveDropdown's
              Publish button so the two dropdowns read as siblings.
              Horizontal padding is supplied by the outer `p-2`. */}
          <div className="pt-1 flex flex-col gap-2">
            {canUseSelected ? (
              <button
                type="button"
                onClick={onExport}
                disabled={exporting}
                className="w-full h-7 px-3 text-xs cut-corners font-medium flex items-center justify-center bg-[var(--accent)] hover:bg-[var(--accent-hover,var(--accent))] text-[var(--accent-fg)] transition-colors cursor-pointer disabled:opacity-100 disabled:cursor-not-allowed"
              >
                {exporting ? 'Exporting…' : 'Export project'}
              </button>
            ) : (
              <button
                type="button"
                onClick={onUpgrade}
                title={`${selected.label} export requires Pro`}
                className="w-full h-7 px-3 text-xs cut-corners font-medium flex items-center justify-center bg-[var(--accent)] hover:bg-[var(--accent-hover,var(--accent))] text-[var(--accent-fg)] transition-colors cursor-pointer"
              >
                Upgrade
              </button>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
