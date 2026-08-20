// NewWebsiteTemplatesModal.tsx — "Start from a template" prompt for
// brand-new cloud websites.
//
// Armed by ProjectLoader when a cloud site loads with ZERO files (the
// dashboard's New Website flow creates the row empty). Card order: a
// white "start from scratch" tile first, then the FREE approved
// marketplace templates, then the PAID ones. Picking a free one calls
// the remix endpoint with `intoWebsiteId` so the template is applied
// INTO this website (assets deep-copied, `is_remix` stamped — same
// royalty path as a normal remix) and the page reloads on the same
// /builder/:id URL. Paid templates open their marketplace page in a new
// tab (purchase happens there); the modal stays open. Closing keeps the
// blank canvas and is remembered per site, then hands off to the
// first-run onboarding tour if that hasn't been seen yet.

import { useEffect, useState } from 'react';
import Modal from '@/design-system/Modal';
import {
  listApprovedTemplates,
  remixTemplateIntoWebsite,
  isFreeTemplate,
  type ApprovedTemplate,
} from '@/backend/revyme-backend';
import { getProjectId } from '@/backend/project-id';
import { cancelPendingAutosave } from '@/backend/autosave';
import {
  useTemplatePromptArmed,
  setTemplatePromptArmed,
  templatePromptDismissKey,
} from '@/code/stores/fresh-site-store';
import { startOnboarding, ONBOARDING_COMPLETED_KEY } from '@/editor/onboarding';
import { SketchPencilIcon } from '@/shared/icons';
import { trace } from '@/shared/debug-trace';

export default function NewWebsiteTemplatesModal() {
  const armed = useTemplatePromptArmed();
  const [templates, setTemplates] = useState<ApprovedTemplate[] | null>(null);
  // Hold the modal until the canvas has painted behind it — same signal the
  // loading-shell fade uses. Showing it over the pulsing shell looks broken.
  const [revealed, setRevealed] = useState(false);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!armed) return;
    let cancelled = false;
    listApprovedTemplates()
      .then((rows) => {
        if (cancelled) return;
        if (rows.length === 0) {
          // Nothing to offer — stand down silently, blank canvas it is.
          trace.action('template-prompt:empty-catalog');
          setTemplatePromptArmed(false);
          return;
        }
        // Free first, paid after — paid cards deep-link to the marketplace.
        setTemplates([...rows.filter(isFreeTemplate), ...rows.filter((t) => !isFreeTemplate(t))]);
      })
      .catch((err) => {
        if (cancelled) return;
        trace.error('template-prompt:load-failed', { error: String(err) });
        setTemplatePromptArmed(false);
      });
    return () => { cancelled = true; };
  }, [armed]);

  useEffect(() => {
    if (!armed || revealed) return;
    let timer: ReturnType<typeof setTimeout>;
    const reveal = () => {
      // Small delay so the loading shell's 280ms fade finishes first.
      timer = setTimeout(() => setRevealed(true), 400);
    };
    window.addEventListener('revyme:render-complete', reveal, { once: true });
    // Failsafe mirrors the shell overlay's: never gate the prompt on an
    // event that might have fired before this mounted (or never fires).
    const failsafe = setTimeout(() => setRevealed(true), 4500);
    return () => {
      window.removeEventListener('revyme:render-complete', reveal);
      clearTimeout(timer);
      clearTimeout(failsafe);
    };
  }, [armed, revealed]);

  const dismiss = () => {
    if (applyingId) return;
    const id = getProjectId();
    trace.action('template-prompt:dismiss', { id });
    localStorage.setItem(templatePromptDismissKey(id), '1');
    setTemplatePromptArmed(false);
    // The first-run tour deferred its auto-start while this prompt was
    // armed (see OnboardingTutorial) — hand back to it now.
    if (!localStorage.getItem(ONBOARDING_COMPLETED_KEY)) startOnboarding();
  };

  const apply = async (tpl: ApprovedTemplate) => {
    if (applyingId) return;
    setApplyingId(tpl.id);
    setError(null);
    trace.action('template-prompt:apply', { templateId: tpl.id });
    try {
      await remixTemplateIntoWebsite(tpl.id, getProjectId());
      // The backend rewrote this website's row with the template files.
      // Drop any queued autosave BEFORE reloading — a debounced save or
      // the unload beacon would PUT this tab's empty scaffold back over
      // the applied template.
      cancelPendingAutosave();
      trace.action('template-prompt:applied', { templateId: tpl.id });
      window.location.reload();
    } catch (err) {
      trace.error('template-prompt:apply-failed', { templateId: tpl.id, error: String(err) });
      const msg = err instanceof Error && err.message && !/^Remix failed/.test(err.message)
        ? err.message
        : 'Something went wrong applying the template. Please try again.';
      setError(msg);
      setApplyingId(null);
    }
  };

  // Paid templates aren't remixable until purchased — the checkout lives on
  // the marketplace detail page, so open it in a new tab and keep the
  // prompt up (the user comes back or remixes from there after buying).
  const openMarketplace = (tpl: ApprovedTemplate) => {
    if (applyingId) return;
    trace.action('template-prompt:open-marketplace', { templateId: tpl.id, slug: tpl.slug });
    window.open(`/templates/${encodeURIComponent(tpl.slug ?? tpl.id)}`, '_blank', 'noopener');
  };

  const isOpen = armed && revealed && !!templates && templates.length > 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={dismiss}
      title="Start with a template"
      width={680}
      hideClose={!!applyingId}
    >
      <div className="p-4">
        <p className="mb-3 text-[12px] leading-relaxed text-[var(--text-secondary)]">
          Pick a template to start from, or start from a blank canvas.
        </p>

        <div className="grid max-h-[56vh] grid-cols-3 gap-3 overflow-auto pr-1">
          <ScratchCard disabled={!!applyingId} onPick={dismiss} />
          {(templates ?? []).map((tpl) => {
            const free = isFreeTemplate(tpl);
            return (
              <TemplateCard
                key={tpl.id}
                tpl={tpl}
                free={free}
                applying={applyingId === tpl.id}
                disabled={!!applyingId}
                onPick={() => (free ? apply(tpl) : openMarketplace(tpl))}
              />
            );
          })}
        </div>

        {error && <div className="mt-3 text-[12px] text-[#e5484d]">{error}</div>}
      </div>
    </Modal>
  );
}

/** First card — the blank-canvas choice, drawn as a white page with a
 *  pencil. White in BOTH modes on purpose: it depicts the empty canvas,
 *  not the chrome. Same dismiss path as closing the modal. */
function ScratchCard({ disabled, onPick }: { disabled: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      className="group flex flex-col overflow-hidden cut-corners cut-border [--cut-border-color:var(--border-default)] hover:[--cut-border-color:var(--accent)] border border-[var(--border-default)] bg-[var(--bg-surface)] text-left transition-colors hover:border-[var(--accent)] disabled:opacity-60"
    >
      <span className="grid aspect-[4/3] w-full place-items-center bg-white">
        <SketchPencilIcon size={28} className="text-[#111111] transition-transform duration-300 group-hover:scale-110" />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5 px-2.5 py-2">
        <span className="truncate text-[12px] font-medium text-[var(--text-primary)]">Start from scratch</span>
        <span className="truncate text-[11px] text-[var(--text-tertiary)]">Blank canvas</span>
      </span>
    </button>
  );
}

function priceLabel(priceCents: number | null): string {
  const cents = priceCents ?? 0;
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

function TemplateCard({ tpl, free, applying, disabled, onPick }: {
  tpl: ApprovedTemplate;
  free: boolean;
  applying: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      title={free ? undefined : 'Opens the marketplace page'}
      className="group flex flex-col overflow-hidden cut-corners cut-border [--cut-border-color:var(--border-default)] hover:[--cut-border-color:var(--accent)] border border-[var(--border-default)] bg-[var(--bg-surface)] text-left transition-colors hover:border-[var(--accent)] disabled:opacity-60"
    >
      <span className="relative block aspect-[4/3] w-full overflow-hidden bg-[var(--bg-hover)]">
        {tpl.thumbnail_url ? (
          <img
            src={tpl.thumbnail_url}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover object-top transition-transform duration-300 group-hover:scale-[1.03]"
          />
        ) : (
          <span className="grid h-full w-full place-items-center text-[20px] font-semibold text-[var(--text-tertiary)]">
            {(tpl.name || '?').charAt(0).toUpperCase()}
          </span>
        )}
        {applying && (
          <span className="absolute inset-0 grid place-items-center bg-black/50 text-[11px] font-medium text-white">
            Applying…
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5 px-2.5 py-2">
        <span className="truncate text-[12px] font-medium text-[var(--text-primary)]">{tpl.name}</span>
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-[11px] text-[var(--text-tertiary)]">
            {tpl.author ?? 'Revyme'}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-0.5 rounded bg-[var(--bg-hover)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--text-primary)]">
            {free ? 'Free' : priceLabel(tpl.price_cents)}
            {!free && (
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 17 17 7M9 7h8v8" />
              </svg>
            )}
          </span>
        </span>
      </span>
    </button>
  );
}
