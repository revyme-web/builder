// RemixWorkspacePicker.tsx — "which workspace should this copy live in?",
// asked INSIDE the builder, over the site it's about.
//
// The remix already happened. The backend's `resolveRemixWorkspace` defaults to
// the user's PERSONAL workspace when the remix call names none, so the copy is
// created immediately and `/builder/<newId>` opens the REAL, editable site.
// This modal then moves it if the user wants it elsewhere
// (PATCH /websites/:id/workspace) and closes — no reload, no read-only preview.
//
// It replaced a version that ran BEFORE any project existed: it rendered over a
// black screen, and choosing triggered the remix + a full page load. Asking
// after means the user answers while looking at the site.
//
// OBLIGATORY. No ×, no Escape, no backdrop — the modal is the only thing
// standing between a fresh copy and a workspace the user actually meant. There
// is nothing destructive behind it (the site already exists in Personal), so
// the single action confirms the selection, defaulting to where it already is.

import { useEffect, useState } from 'react';
import Modal from '@/design-system/Modal';
import {
  listAttachableWorkspaces,
  setWebsiteWorkspace,
  type AttachableWorkspace,
} from '@/backend/revyme-backend';
import { trace } from '@/shared/debug-trace';

interface Props {
  /** The freshly-remixed website — already created, already open behind this. */
  websiteId: string;
  /** Close the modal (the site stays wherever it now is). */
  onDone: () => void;
}

export default function RemixWorkspacePicker({ websiteId, onDone }: Props) {
  const [workspaces, setWorkspaces] = useState<AttachableWorkspace[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    trace.action('remix-picker:open', { websiteId });
    listAttachableWorkspaces()
      .then((rows) => {
        if (cancelled) return;
        setWorkspaces(rows);
        // Preselect the personal workspace (or first) so the common case
        // is a single click.
        const preferred = rows.find((r) => r.is_personal) ?? rows[0];
        setSelected(preferred?.id ?? null);
        trace.action('remix-picker:loaded', { count: rows.length });
      })
      .catch((err) => {
        if (cancelled) return;
        trace.error('remix-picker:load-failed', { error: String(err) });
        setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [websiteId]);

  const confirm = async () => {
    if (!selected || saving) return;
    setSaving(true);
    setSaveError(null);
    trace.action('remix-picker:assign', { websiteId, workspaceId: selected });
    try {
      // A no-op server-side when it's already this workspace, so the common
      // "keep it in Personal" path costs one cheap round trip and no branching.
      await setWebsiteWorkspace(websiteId, selected);
      trace.action('remix-picker:assigned', { websiteId, workspaceId: selected });
      onDone();
    } catch (err) {
      trace.error('remix-picker:assign-failed', { error: String(err) });
      setSaveError(err instanceof Error ? err.message : 'Could not move this site. Please try again.');
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onDone} title="Choose a workspace" width={300} dismissible={false}>
      <div className="flex flex-col gap-3 px-3 py-3">
        <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
          Your copy lives here. Move it if you’d rather keep it somewhere else.
        </p>

        {loadError ? (
          <p className="py-3 text-center text-xs text-[var(--text-secondary)]">
            Could not load your workspaces. Please refresh and try again.
          </p>
        ) : workspaces === null ? (
          <p className="py-3 text-center text-xs text-[var(--text-tertiary)]">Loading workspaces…</p>
        ) : workspaces.length === 0 ? (
          <p className="py-3 text-center text-xs text-[var(--text-secondary)]">
            You don’t have a workspace you can add to.
          </p>
        ) : (
          <div className="flex max-h-[38vh] flex-col gap-1 overflow-auto">
            {workspaces.map((ws) => {
              const isSel = ws.id === selected;
              return (
                <button
                  key={ws.id}
                  type="button"
                  onClick={() => setSelected(ws.id)}
                  disabled={saving}
                  className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-lg)] border px-2 py-1.5 text-left transition-colors disabled:opacity-60"
                  style={{
                    borderColor: isSel ? 'var(--accent)' : 'var(--border-light)',
                    background: isSel ? 'var(--accent-surface)' : 'transparent',
                  }}
                >
                  <WorkspaceAvatar ws={ws} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-[var(--text-primary)]">
                      {ws.name}
                    </span>
                    <span className="block text-[10px] capitalize text-[var(--text-tertiary)]">
                      {ws.is_personal ? 'Personal' : ws.role}
                    </span>
                  </span>
                  {isSel && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {saveError && <p className="text-xs text-[var(--accent-danger,#dc2626)]">{saveError}</p>}

        <button
          type="button"
          onClick={confirm}
          disabled={!selected || saving || loadError}
          style={{ backgroundColor: 'var(--accent)', color: 'var(--accent-fg)' }}
          className="h-8 w-full cursor-pointer rounded-[var(--radius-lg)] text-xs font-medium hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Continue'}
        </button>
      </div>
    </Modal>
  );
}

function WorkspaceAvatar({ ws }: { ws: AttachableWorkspace }) {
  if (ws.logo) {
    return <img src={ws.logo} alt="" className="h-6 w-6 shrink-0 rounded-[var(--radius-md)] object-cover" />;
  }
  const initial = (ws.name || '?').charAt(0).toUpperCase();
  return (
    <span
      className="grid h-6 w-6 shrink-0 place-items-center rounded-[var(--radius-md)] text-[11px] font-semibold"
      style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
    >
      {initial}
    </span>
  );
}
