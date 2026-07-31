// RemixWorkspacePicker.tsx — Blocking workspace chooser shown before a
// template remix is finalized.
//
// The remix endpoint only creates the new `websites` row once we call it,
// so we DON'T remix on load anymore — we show this picker first. The user
// must choose a workspace they can build in (owner/admin/editor; viewers
// and per-site guests are filtered out server-side by /workspaces/attachable).
// Only then do we perform the remix with that workspace, so the copy always
// lands in a dashboard the user controls. Cancelling creates nothing (no
// orphaned site) and returns to the dashboard.

import { useEffect, useState } from 'react';
import Modal from '@/design-system/Modal';
import {
  listAttachableWorkspaces,
  remixTemplate,
  remixTemplateShare,
  type AttachableWorkspace,
} from '@/backend/revyme-backend';
import { trace } from '@/shared/debug-trace';

interface Props {
  kind: 'approved' | 'share';
  token: string;
}

export default function RemixWorkspacePicker({ kind, token }: Props) {
  const [workspaces, setWorkspaces] = useState<AttachableWorkspace[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    trace.action('remix-picker:open', { kind, token });
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
  }, [kind, token]);

  const cancel = () => {
    if (creating) return;
    trace.action('remix-picker:cancel', { kind, token });
    window.location.replace('/dashboard');
  };

  const create = async () => {
    if (!selected || creating) return;
    setCreating(true);
    setCreateError(null);
    trace.action('remix-picker:create', { kind, token, workspaceId: selected });
    try {
      const result =
        kind === 'approved'
          ? await remixTemplate(token, selected)
          : await remixTemplateShare(token, selected);
      trace.action('remix-picker:created', { websiteId: result.website_id });
      window.location.replace(`/builder/${result.website_id}`);
    } catch (err) {
      trace.error('remix-picker:create-failed', { error: String(err) });
      // Backend messages are user-readable (e.g. the paid-template purchase
      // gate) — show them verbatim; keep the generic line as the fallback.
      const msg = err instanceof Error && err.message && !/^Remix failed/.test(err.message)
        ? err.message
        : 'Something went wrong creating your copy. Please try again.';
      setCreateError(msg);
      setCreating(false);
    }
  };

  return (
    <Modal isOpen onClose={cancel} title="Add this template to a workspace" width={440} hideClose={creating}>
      <div className="p-4">
        <p className="mb-3 text-[12px] leading-relaxed text-[var(--text-secondary)]">
          Choose which workspace to add your copy to — it’ll appear in that workspace’s dashboard.
        </p>

        {loadError ? (
          <div className="py-6 text-center text-[12px] text-[var(--text-secondary)]">
            Could not load your workspaces. Please refresh and try again.
          </div>
        ) : workspaces === null ? (
          <div className="py-6 text-center text-[12px] text-[var(--text-tertiary)]">Loading workspaces…</div>
        ) : workspaces.length === 0 ? (
          <div className="py-6 text-center text-[12px] text-[var(--text-secondary)]">
            You don’t have a workspace you can add to.
          </div>
        ) : (
          <div className="flex max-h-[42vh] flex-col gap-1.5 overflow-auto">
            {workspaces.map((ws) => {
              const isSel = ws.id === selected;
              return (
                <button
                  key={ws.id}
                  type="button"
                  onClick={() => setSelected(ws.id)}
                  disabled={creating}
                  className="flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-60"
                  style={{
                    borderColor: isSel ? 'var(--accent)' : 'var(--border-default)',
                    background: isSel ? 'var(--accent-surface)' : 'var(--bg-surface)',
                  }}
                >
                  <WorkspaceAvatar ws={ws} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-[var(--text-primary)]">
                      {ws.name}
                    </span>
                    <span className="block text-[11px] capitalize text-[var(--text-tertiary)]">
                      {ws.is_personal ? 'Personal' : ws.role}
                    </span>
                  </span>
                  <span
                    className="grid h-4 w-4 shrink-0 place-items-center rounded-full border"
                    style={{ borderColor: isSel ? 'var(--accent)' : 'var(--border-default)' }}
                  >
                    {isSel && <span className="h-2 w-2 rounded-full" style={{ background: 'var(--accent)' }} />}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {createError && <div className="mt-3 text-[12px] text-[#e5484d]">{createError}</div>}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={cancel}
            disabled={creating}
            className="h-8 rounded-md px-3 text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={create}
            disabled={!selected || creating || loadError}
            className="h-8 rounded-md px-3.5 text-[12px] font-semibold text-white transition-colors disabled:opacity-50"
            style={{ background: 'var(--accent)' }}
          >
            {creating ? 'Creating copy…' : 'Create copy'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function WorkspaceAvatar({ ws }: { ws: AttachableWorkspace }) {
  if (ws.logo) {
    return <img src={ws.logo} alt="" className="h-8 w-8 shrink-0 rounded-md object-cover" />;
  }
  const initial = (ws.name || '?').charAt(0).toUpperCase();
  return (
    <span
      className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-[13px] font-semibold text-white"
      style={{ background: 'var(--accent)' }}
    >
      {initial}
    </span>
  );
}
