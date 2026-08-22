// LiveDropdown.tsx — pixel-perfect port of the old builder's Live/Publish
// dropdown (builder/src/builder/view/header/RightHeader.tsx ~lines 762-870).
//
// Behavior: Live button always opens this dropdown. Inside, the user sees
// the live URL (when published) and a Publish / Update live site primary
// button. While publishing, the button shows a fake-but-monotonic progress
// bar (0 → 95% over ~25s sigmoid-like, jumps to 100% on real success) —
// pure UX so the 25s deploy doesn't feel dead.

import { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { WebsiteMeta } from '@/backend/types';

// ─── Inline icons ────────────────────────────────────────────────────────────
// Hand-rolled to avoid an icon-package dep just for four glyphs. Style
// matches lucide's defaults: 24×24 viewBox, currentColor stroke, 2 px
// stroke width, round caps + joins, no fill. Each accepts a `size` prop
// the caller passes in px.

interface IconProps {
  size?: number;
  className?: string;
}

function svgProps(size: number, className?: string) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
  };
}

function Check({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function Clock({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function ExternalLink({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function Globe({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

// Rewind / "from backup" glyph — distinguishes the backup state from the
// normal "Last published" clock.
function Rewind({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <polyline points="3 3 3 8 8 8" />
    </svg>
  );
}

interface Props {
  open: boolean;
  meta: WebsiteMeta | null;
  publishing: boolean;
  publishSuccess: boolean;
  /** 0–1, advances during publishing. The dropdown renders a fill bar
   *  inside the primary button. */
  progress: number;
  onPublish: () => void;
  onClose: () => void;
  /** Open the Settings overlay on the Backups tab. Wired from the
   *  parent so this component stays pure-presentation. Shown next to
   *  the "Live from backup" line. */
  onOpenBackups?: () => void;
  /** Open the Settings overlay on the Domain tab. Shown as a small
   *  grey button above "Update live site" — but only when no custom
   *  domain is connected yet (i.e. site is on auto subdomain or
   *  custom subdomain, not on an external domain). */
  onAddDomain?: () => void;
  /** Open the Settings overlay on the Staging tab. Shown as a small
   *  grey button above "Update live site". The actual deploy + promote
   *  actions live in the Settings tab to keep this dropdown compact. */
  onOpenStaging?: () => void;
}

export function LiveDropdown({ open, meta, publishing, publishSuccess, progress, onPublish, onClose, onOpenBackups, onAddDomain, onOpenStaging }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Outside-click close — but only when the click is genuinely outside the
  // dropdown root. The Live button itself toggles open/close on its own
  // onClick, so we filter clicks on `[data-live-trigger]` so the toggle
  // doesn't fight a "close because outside" race.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (ref.current && !ref.current.contains(target) && !target.closest('[data-live-trigger]')) {
        onClose();
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open, onClose]);

  const liveUrl = meta?.customDomain
    ? `https://${meta.customDomain}`
    : meta?.customSubdomain
    ? `https://${meta.customSubdomain}.revyme.app`
    : meta?.subdomain
    ? `https://${meta.subdomain}.revyme.app`
    : null;

  const liveLabel = meta?.customDomain
    ? meta.customDomain
    : meta?.customSubdomain
    ? `${meta.customSubdomain}.revyme.app`
    : meta?.subdomain
    ? `${meta.subdomain}.revyme.app`
    : null;

  // When there's no live URL yet, the dropdown collapses to just the
  // primary button — no "Not published yet" placeholder, no divider
  // above an empty space.
  const showHeader = !!liveUrl || !!meta?.publishedAt;

  return (
    <AnimatePresence>
      {open && (
    <motion.div
      ref={ref}
      onClick={(e) => e.stopPropagation()}
      // Bouncy intro — `back.out(1.7)`-equivalent spring tuned to feel
      // like the rest of the editor's dropdowns.
      initial={{ opacity: 0, scale: 0.95, y: -10 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95, y: -10 }}
      transition={{ type: 'spring', stiffness: 400, damping: 22, mass: 0.8 }}
      className="absolute top-full mt-6 right-0 bg-[var(--dropdown-bg)] shadow-[var(--shadow-lg)] cut-corners cut-lg cut-border [--cut-border-color:var(--border-light)] border border-[var(--border-light)] py-2 z-[10001] min-w-[220px]"
    >
      <div className="flex flex-col gap-1 px-2">
        {/* URL + last-published rows only render when actually published.
            Pre-publish, the dropdown collapses to just the primary button
            — no "Not published yet" placeholder, no divider above empty
            space. */}
        {liveUrl && (
          <a
            href={liveUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-2 py-2 text-xs text-[var(--text-primary)] hover:text-[var(--text-secondary)] transition-colors cursor-pointer"
          >
            <Globe size={12} />
            <span className="flex-1 truncate">{liveLabel}</span>
            <ExternalLink size={12} />
          </a>
        )}

        {meta?.publishedAt && (
          <div className="flex items-center gap-2 px-2 py-1 text-[10px] text-[var(--text-secondary)]">
            <Clock size={10} />
            <span>Last: {timeAgo(meta.publishedAt)}</span>
          </div>
        )}

        {/* "Live from backup" — only when the snapshot currently deployed
            isn't the most-recent one for the site (i.e. the user clicked
            Restore at some point). The date shown is the snapshot's
            created_at, not published_at, so the user sees the original
            version date rather than the restore time. Trailing "Manage"
            chip jumps to the Backups settings tab. */}
        {meta?.liveSnapshotId
          && meta?.latestSnapshotId
          && meta.liveSnapshotId !== meta.latestSnapshotId
          && meta.liveSnapshotCreatedAt && (
          <div className="flex items-center justify-between gap-2 px-2 py-1 text-[10px] text-amber-400/90">
            <span className="flex items-center gap-2 min-w-0">
              <Rewind size={10} />
              <span className="truncate">Live from backup · {shortDate(meta.liveSnapshotCreatedAt)}</span>
            </span>
            {onOpenBackups && (
              <button
                type="button"
                onClick={() => { onOpenBackups(); onClose(); }}
                className="flex-shrink-0 px-1.5 py-0.5 cut-corners cut-border text-[10px] font-medium text-amber-400 border border-amber-400/40 hover:bg-amber-400/10 transition-colors cursor-pointer"
              >
                Manage
              </button>
            )}
          </div>
        )}

        {showHeader && <div className="h-[1px] bg-[var(--border-light)] mx-2 my-1" />}

        <div className="px-2 py-2 flex flex-col gap-2">
          {/* "Add domain" — only when no external custom domain is
              connected. Disappears once the user wires up an apex/sub
              external domain via the Domain settings tab. Stays visible
              during an in-flight publish so the dropdown layout doesn't
              jump mid-deploy; clicking it opens the Domain settings
              tab (the publish API call continues in the background
              regardless of UI state). */}
          {onAddDomain && !meta?.customDomain && (
            <button
              type="button"
              onClick={() => { onAddDomain(); onClose(); }}
              className="w-full h-7 px-3 text-xs cut-corners font-medium flex items-center justify-center bg-[var(--button-secondary-bg)] hover:bg-[var(--button-secondary-hover)] text-[var(--text-primary)] transition-colors cursor-pointer"
            >
              Add domain
            </button>
          )}

          {/* "Manage staging" — quick jump to the Settings → Staging tab.
              We don't deploy directly from this dropdown because picking
              the right env (Studio can have many) + a 25s build progress
              bar + promote action would overload the dropdown. The
              Settings tab is the proper surface for staging operations. */}
          {onOpenStaging && (
            <button
              type="button"
              onClick={() => { onOpenStaging(); onClose(); }}
              className="w-full h-7 px-3 text-xs cut-corners font-medium flex items-center justify-center bg-[var(--button-secondary-bg)] hover:bg-[var(--button-secondary-hover)] text-[var(--text-primary)] transition-colors cursor-pointer"
            >
              Manage staging
            </button>
          )}

          <button
            type="button"
            onClick={onPublish}
            disabled={publishing || publishSuccess}
            className="relative overflow-hidden w-full h-7 px-3 text-xs cut-corners transition-colors font-medium flex items-center justify-center gap-1.5 bg-[var(--accent)] hover:bg-[var(--accent-hover,var(--accent))] text-[var(--accent-fg)] disabled:opacity-100 disabled:bg-[var(--accent)] disabled:cursor-not-allowed"
          >
            {/* Progress fill — sits behind the label, advances 0 → 100% while
                publishing. Tinted with `--accent-fg`, NOT white: accent-fg is by
                definition the ink that contrasts with whatever `--accent` is, so
                the fill darkens a light accent and lightens a dark one and reads
                either way. A flat `white/20` only worked while the accent was
                dark — on the light accent it was beige-on-beige and the bar was
                effectively invisible (2026-08-01). */}
            {publishing && (
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 transition-[width] duration-300 ease-out"
                style={{
                  width: `${Math.round(progress * 100)}%`,
                  backgroundColor: 'color-mix(in srgb, var(--accent-fg) 24%, transparent)',
                }}
              />
            )}
            <span className="relative">
              {publishing
                ? `Publishing… ${Math.round(progress * 100)}%`
                : publishSuccess
                // accent-fg, not white: sits on the accent fill, same reason as
                // the progress bar above.
                ? <Check size={14} className="text-[var(--accent-fg)]" />
                : meta?.isPublished
                ? 'Update live site'
                : 'Go live'}
            </span>
          </button>
        </div>
      </div>
    </motion.div>
      )}
    </AnimatePresence>
  );
}

function timeAgo(dateString: string): string {
  const now = Date.now();
  const past = new Date(dateString).getTime();
  const diff = Math.floor((now - past) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} minutes ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hours ago`;
  return `${Math.floor(diff / 86400)} days ago`;
}

// Compact date label for the "Live from backup" line. Format: "Mar 14"
// for this year, "Mar 14, 2025" for older — same shape as the
// BackupsSection list rows but more compact.
function shortDate(dateString: string): string {
  const d = new Date(dateString);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}
