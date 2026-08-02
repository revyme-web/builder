// LinkedComponentModal.tsx — "Edit Component" modal for CDN-linked
// instances. Reuses `CompactModalShell` from NameInputModal — same width
// (w-64), same header (px-3 py-2 border-b), same content padding
// (p-3), same button height (h-8 text-xs).
//
// Mirrors the reference's UI: when the user double-clicks a component instance
// imported from a marketplace URL, they see this modal explaining the
// instance is linked and offering two unlink paths:
//
//   • Unlink Instance      — turn this instance into a local component
//                             on the current page only
//   • Unlink & Replace All — same, but replace all instances on the page

import { useState, useEffect } from 'react';
import { CompactModalShell } from '@/editor/ui/NameInputModal';
import { unlinkCdnComponent } from './component-paste';
import { useCdnMetadataCache, useEnsureCdnMetadata } from './cdn-metadata-hook';
import { trace } from '@/shared/debug-trace';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** The CDN URL of the linked component (the one in the page import). */
  cdnUrl: string | null;
  /** The instance node that opened the modal. Required for "Unlink
   *  Instance" — without it we can only do "Unlink & Replace All"
   *  (URL-import rewrite) which silently turns every sibling instance
   *  on the page into a local copy too. */
  instanceNodeId: string | null;
}

export default function LinkedComponentModal({ isOpen, onClose, cdnUrl, instanceNodeId }: Props) {
  const [busy, setBusy] = useState<'instance' | 'all' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Closed-source components hide the Unlink options entirely (the server
  // refuses the TSX anyway — this keeps the UI honest about it).
  //
  // THREE-STATE verdict, so the closed-source message never flashes the
  // Unlink buttons first: while the metadata is UNKNOWN (fetch in flight —
  // rare, since usePrefetchCdnMetadataForActiveFile warms the cache the
  // moment the page loads) we render neither. `'missing'` (orphan URL) and
  // `'error'` (network failure — the ensure caches it so this can't hang)
  // FAIL OPEN to the buttons: the server still enforces closed-source on
  // the actual unlink call.
  const ensureMetadata = useEnsureCdnMetadata();
  const metadataCache = useCdnMetadataCache();
  useEffect(() => { if (isOpen && cdnUrl) ensureMetadata(cdnUrl); }, [isOpen, cdnUrl, ensureMetadata]);
  const meta = cdnUrl ? metadataCache.get(cdnUrl) : undefined;
  const verdict: 'checking' | 'closed' | 'open' =
    meta === undefined ? 'checking'
    : meta !== 'missing' && meta !== 'error' && meta.closedSource ? 'closed'
    : 'open';
  const isClosedSource = verdict === 'closed';

  // Reset on open. (Escape-to-close lives in CompactModalShell.)
  useEffect(() => {
    if (!isOpen) return;
    setBusy(null);
    setError(null);
  }, [isOpen, onClose]);

  if (!cdnUrl) return null;

  async function handleUnlink(replaceAll: boolean) {
    if (!cdnUrl || busy) return;
    // Single-instance unlink requires a target node id — without one
    // we'd have to fall back to the URL-rewrite path, which is exactly
    // what we want to AVOID for "Unlink Instance". Bail with a visible
    // error so the user re-opens the modal from a selected instance.
    if (!replaceAll && !instanceNodeId) {
      setError('No instance selected — open via double-click or the panel button.');
      return;
    }
    setBusy(replaceAll ? 'all' : 'instance');
    setError(null);
    trace.action('linked-component-modal:unlink-click', { cdnUrl, replaceAll, instanceNodeId });
    try {
      const ok = await unlinkCdnComponent({
        cdnUrl,
        replaceAll,
        instanceNodeId: replaceAll ? null : instanceNodeId,
      });
      if (!ok) throw new Error('Unlink failed');
      onClose();
    } catch (err) {
      setError((err as Error).message || 'Unlink failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <CompactModalShell isOpen={isOpen} onClose={onClose} title="Edit Component">
      {/* Content */}
      <div className="p-3 flex flex-col gap-2">
        <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
          This component instance is linked to a primary component in another project.
        </p>

        {error && <span className="text-[10px] text-red-400">{error}</span>}

        {isClosedSource && (
          <p className="text-[11px] leading-relaxed text-[var(--text-tertiary)]">
            This component is closed source — the creator chose not to share its
            code, so it can't be unlinked into your project. You can keep using
            and configuring it as a linked instance.
          </p>
        )}

        {/* Metadata still in flight — show nothing actionable so the Unlink
            buttons never flash before a closed-source verdict lands. */}
        {verdict === 'checking' && (
          <p className="text-[11px] leading-relaxed text-[var(--text-tertiary)]">
            Checking source availability…
          </p>
        )}

        {verdict === 'open' && <button
          type="button"
          onClick={() => handleUnlink(false)}
          disabled={!!busy || !instanceNodeId}
          title={!instanceNodeId
            ? 'Select an instance on the canvas to enable per-instance unlink'
            : undefined}
          className="w-full h-8 text-xs font-medium text-[var(--text-primary)] bg-[var(--button-secondary-bg,rgba(255,255,255,0.06))] hover:brightness-125 rounded-[var(--radius-lg)] transition-[filter] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {busy === 'instance' ? 'Unlinking…' : 'Unlink Instance'}
        </button>}
        {verdict === 'open' && <button
          type="button"
          onClick={() => handleUnlink(true)}
          disabled={!!busy}
          className="w-full h-8 text-xs font-medium text-white rounded-[var(--radius-lg)] transition-[filter] hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          // `--accent` is the editor's primary accent (blue by
          // default). `App.tsx` swaps it to `--accent-secondary`
          // (purple) on `<html>` whenever the active file is a
          // component master, so this single token gives us the
          // right color in both contexts without a manual check.
          style={{ backgroundColor: 'var(--accent, #cec997)' }}
        >
          {busy === 'all' ? 'Unlinking…' : 'Unlink & Replace All'}
        </button>}
      </div>
    </CompactModalShell>
  );
}
