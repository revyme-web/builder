// EnvironmentsSection.tsx — Per-site staging deploy targets.
//
// Pro: one fixed slot named 'staging'.
// Studio: unlimited named slots (capped at 20/site by the backend, surfaced
//         as "Unlimited" on the plan card).
// Free/Lite: locked overlay + upsell to Pro.
//
// Per-row UI:
//   <avatar>  Environment name        <last deployed date>    [Actions ▾]
//             <url>                                              ├ Deploy from editor
//             "Never deployed" | "Snapshot from <date>"          ├ Promote to prod
//                                                                ├──────────────
//                                                                └ Delete

import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { useSetAtom } from 'jotai';
import { trace } from '@/shared/debug-trace';
import { Skeleton } from '@/editor/overlays/settings-shared';
import { settingsSectionAtom } from '@/code/stores/website-settings-store';
import { useSigmoidProgress } from '@/editor/hooks/useSigmoidProgress';
import { type DropdownMenuEntry } from '@/design-system/DropdownMenu';
import { ConfirmModalShell, ModalCancelButton, RowActionsMenu, useEscapeToClose } from './shared';

interface EnvironmentRow {
  id: string;
  website_id: string;
  name: string;
  worker_name: string;
  current_snapshot_id: string | null;
  last_deployed_at: string | null;
  created_at: string;
  url: string;
}

interface ListResponse {
  environments: EnvironmentRow[];
  canManage: boolean;   // Pro+
  isStudio: boolean;
}

interface EnvironmentsSectionProps {
  websiteId: string;
}

export default function EnvironmentsSection({ websiteId }: EnvironmentsSectionProps) {
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyEnvId, setBusyEnvId] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<
    | { kind: 'deploy'; env: EnvironmentRow }
    | { kind: 'promote'; env: EnvironmentRow }
    | { kind: 'delete'; env: EnvironmentRow }
    | null
  >(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const setActiveSection = useSetAtom(settingsSectionAtom);

  const refresh = useCallback(async () => {
    if (!websiteId) return;
    trace.fn('envs-section:fetch', { websiteId });
    setLoading(true);
    try {
      const r = await fetch(`/api/environments?websiteId=${websiteId}`);
      if (r.ok) setData(await r.json());
    } catch (e) {
      trace.error('envs-section:fetch', e);
    } finally {
      setLoading(false);
    }
  }, [websiteId]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleDeploy = useCallback(async (envId: string): Promise<boolean> => {
    try {
      setBusyEnvId(envId);
      const r = await fetch(`/api/environments/${envId}/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),  // no snapshotId → snapshot current editor first
      });
      if (!r.ok) {
        const err = await r.json().catch(() => null);
        alert(err?.error?.message ?? 'Deploy failed');
        return false;
      }
      return true;
    } catch (e) {
      trace.error('envs-section:deploy', e);
      alert('Deploy failed. Please try again.');
      return false;
    }
  }, []);

  const handlePromote = useCallback(async (envId: string): Promise<boolean> => {
    try {
      setBusyEnvId(envId);
      const r = await fetch(`/api/environments/${envId}/promote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'prod' }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => null);
        alert(err?.error?.message ?? 'Promote failed');
        return false;
      }
      return true;
    } catch (e) {
      trace.error('envs-section:promote', e);
      alert('Promote failed. Please try again.');
      return false;
    }
  }, []);

  const handleDelete = useCallback(async (envId: string): Promise<boolean> => {
    try {
      setBusyEnvId(envId);
      const r = await fetch(`/api/environments/${envId}`, { method: 'DELETE' });
      if (!r.ok) {
        const err = await r.json().catch(() => null);
        alert(err?.error?.message ?? 'Delete failed');
        return false;
      }
      return true;
    } catch (e) {
      trace.error('envs-section:delete', e);
      alert('Delete failed. Please try again.');
      return false;
    }
  }, []);

  const handleCreate = useCallback(async (name: string) => {
    setCreateError(null);
    try {
      const r = await fetch('/api/environments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ websiteId, name }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.environment) {
        setCreateError(j?.error?.message ?? 'Could not create environment');
        return false;
      }
      setShowCreate(false);
      await refresh();
      return true;
    } catch (e) {
      trace.error('envs-section:create', e);
      setCreateError('Network error');
      return false;
    }
  }, [websiteId, refresh]);

  if (!loading && !data) {
    return <p className="text-sm text-[var(--text-secondary)]">Couldn't load staging environments.</p>;
  }

  // Free / Lite — locked upsell. Only show once we know the plan;
  // during the initial fetch fall through to the structural shell.
  if (data && !data.canManage) {
    return (
      <div>
        <div className="pb-6 border-b border-[var(--border-light)]">
          <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1">Staging</h3>
          <p className="text-xs text-[var(--text-secondary)]">
            Deploy versions of your site to separate URLs for testing or client review before promoting them to your live domain.
          </p>
        </div>
        <div className="py-6">
          <button
            onClick={() => setActiveSection('plans')}
            className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent-text)] hover:underline cursor-pointer"
          >
            Upgrade to Pro for a staging environment →
          </button>
        </div>
      </div>
    );
  }

  const environments = data?.environments ?? [];
  const isStudio = data?.isStudio ?? false;
  const canCreate = isStudio || environments.length === 0;

  return (
    <div>
      {/* Header — same idiom as A/B detail page: title + description on
          the left, single action button on the right, sitting flush on
          a hairline border-b. */}
      <div className="flex items-start justify-between gap-3 pb-6 border-b border-[var(--border-light)]">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1">Staging</h3>
          <p className="text-xs text-[var(--text-secondary)]">
            {isStudio
              ? 'Spin up as many staging environments as you need. Deploy any snapshot to any URL, then promote when ready.'
              : 'Your Pro plan includes one staging environment. Upgrade to Studio for unlimited environments.'}
          </p>
        </div>
        {canCreate && (
          <button
            onClick={() => {
              if (isStudio) { setCreateError(null); setShowCreate(true); }
              else void handleCreate('staging');
            }}
            disabled={busyEnvId !== null}
            className="flex-shrink-0 inline-flex items-center justify-center gap-1 h-8 px-3 text-xs font-medium text-[var(--accent-fg)] bg-[var(--accent)] hover:opacity-90 cut-corners cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
          >
            + Create environment
          </button>
        )}
      </div>

      {/* Environment rows — flat list, no card wrappers. Each row is a
          flush row separated from the next by a hairline border-b
          (last:border-b-0 to avoid a stray line above the upsell). */}
      {loading ? (
        <ul>
          {[0, 1].map(i => (
            <li
              key={i}
              className="flex items-center justify-between gap-3 py-4 border-b border-[var(--border-light)] last:border-b-0"
            >
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-48" />
              </div>
              <Skeleton className="h-[30px] w-[110px] cut-corners" />
            </li>
          ))}
        </ul>
      ) : environments.length > 0 && (
        <ul>
          {environments.map((env) => (
            <EnvironmentRowItem
              key={env.id}
              env={env}
              isStudio={isStudio}
              busy={busyEnvId === env.id}
              isMenuOpen={openMenuId === env.id}
              onToggleMenu={() =>
                setOpenMenuId((cur) => (cur === env.id ? null : env.id))
              }
              onCloseMenu={() => setOpenMenuId(null)}
              onDeploy={() => { setOpenMenuId(null); setConfirm({ kind: 'deploy', env }); }}
              onPromote={() => { setOpenMenuId(null); setConfirm({ kind: 'promote', env }); }}
              onDelete={() => { setOpenMenuId(null); setConfirm({ kind: 'delete', env }); }}
            />
          ))}
        </ul>
      )}

      {/* Tier upsell — small inline accent link instead of a big
          gradient banner. Same idiom as analytics' "Lite" badge on
          locked range buttons: low-chrome, high-information. */}
      {!isStudio && environments.length > 0 && (
        <div className="pt-6">
          <button
            onClick={() => setActiveSection('plans')}
            className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent-text)] hover:underline cursor-pointer"
          >
            Upgrade to Studio for unlimited staging environments →
          </button>
        </div>
      )}

      <ActionConfirmModal
        confirm={confirm}
        onCancel={() => setConfirm(null)}
        onRun={async () => {
          if (!confirm) return;
          let ok = false;
          if (confirm.kind === 'deploy') ok = await handleDeploy(confirm.env.id);
          if (confirm.kind === 'promote') ok = await handlePromote(confirm.env.id);
          if (confirm.kind === 'delete') ok = await handleDelete(confirm.env.id);
          if (ok) {
            setBusyEnvId(null);
            setConfirm(null);
            await refresh();
          } else {
            setBusyEnvId(null);
          }
        }}
        canManage={data?.canManage ?? false}
      />

      {canCreate && showCreate && isStudio && (
        <CreateEnvironmentModal
          onCancel={() => setShowCreate(false)}
          onCreate={handleCreate}
          error={createError}
        />
      )}
    </div>
  );
}

// ─── Row ───────────────────────────────────────────────────────────────────

interface EnvironmentRowItemProps {
  env: EnvironmentRow;
  isStudio: boolean;
  busy: boolean;
  isMenuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onDeploy: () => void;
  onPromote: () => void;
  onDelete: () => void;
}

function EnvironmentRowItem({
  env, isStudio, busy, isMenuOpen, onToggleMenu, onCloseMenu,
  onDeploy, onPromote, onDelete,
}: EnvironmentRowItemProps) {
  const items: DropdownMenuEntry[] = [
    { id: 'deploy', label: 'Deploy current editor', onClick: onDeploy },
    {
      id: 'promote',
      label: 'Promote to prod',
      onClick: onPromote,
      disabled: !env.current_snapshot_id,
    },
    { type: 'separator' },
    { id: 'delete', label: 'Delete environment', onClick: onDelete },
  ];

  const deployedLabel = env.last_deployed_at
    ? new Date(env.last_deployed_at).toLocaleString(undefined, {
        weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit',
      })
    : 'Never deployed';

  return (
    <li className="flex items-center justify-between gap-3 py-4 border-b border-[var(--border-light)] last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-[var(--text-primary)] truncate">
          {env.name}
        </p>
        <a
          href={env.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-[var(--text-secondary)] hover:text-[var(--accent-text)] transition-colors truncate inline-block max-w-full"
        >
          {env.url.replace(/^https?:\/\//, '')}  ↗
        </a>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0">
        <div className="text-right leading-tight tabular-nums">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">Last deployed</div>
          <div className="text-xs font-medium text-[var(--text-primary)] mt-0.5">{deployedLabel}</div>
        </div>
        <RowActionsMenu
          items={items}
          isOpen={isMenuOpen}
          disabled={busy}
          onToggle={onToggleMenu}
          onClose={onCloseMenu}
        />
      </div>
    </li>
  );
}

// ─── Action confirm modal (deploy / promote / delete) ──────────────────────

interface ActionConfirm {
  kind: 'deploy' | 'promote' | 'delete';
  env: EnvironmentRow;
}

interface ActionConfirmModalProps {
  confirm: ActionConfirm | null;
  onCancel: () => void;
  onRun: () => Promise<void>;
  canManage: boolean;
}

function ActionConfirmModal({ confirm, onCancel, onRun }: ActionConfirmModalProps) {
  const [running, setRunning] = useState(false);
  const { progress, setProgress, startProgress, stopProgress } = useSigmoidProgress();

  useEffect(() => {
    if (confirm) {
      setRunning(false);
      setProgress(0);
    } else {
      stopProgress();
    }
    return stopProgress;
  }, [confirm, stopProgress]);

  useEscapeToClose(!!confirm, running, onCancel);

  if (!confirm) return null;

  const isDeploy = confirm.kind === 'deploy';
  const isPromote = confirm.kind === 'promote';
  const isDelete = confirm.kind === 'delete';

  const title = isDeploy
    ? `Deploy current editor to "${confirm.env.name}"?`
    : isPromote
      ? `Promote "${confirm.env.name}" to prod?`
      : `Delete "${confirm.env.name}"?`;
  const body = isDeploy
    ? `Your current editor state will be snapshotted and deployed to ${confirm.env.url}. Production is not affected.`
    : isPromote
      ? `${confirm.env.name}'s current snapshot will be deployed to your live site. A safety snapshot of your current prod will be saved first so you can roll back from the Backups tab if needed.`
      : `${confirm.env.name} will be removed. Its deployed Worker + DNS hostname are torn down on Cloudflare. The snapshots that were deployed to it stay in your backups.`;
  const submitText = isDeploy ? 'Deploy' : isPromote ? 'Promote to prod' : 'Delete environment';

  const handleRun = async () => {
    setRunning(true);
    startProgress();
    try {
      await onRun();
      stopProgress();
      setProgress(1);
    } catch {
      stopProgress();
      setRunning(false);
    }
  };

  return (
    <ConfirmModalShell
      open
      locked={running}
      onCancel={onCancel}
      title={title}
      widthClassName="w-[420px] max-w-[calc(100vw-2rem)]"
    >
      <p className="text-xs leading-relaxed text-[var(--text-secondary)]">{body}</p>
      <div className="flex items-center gap-2 pt-1">
        <ModalCancelButton onClick={onCancel} disabled={running} />
        <button
          onClick={() => { void handleRun(); }}
          disabled={running}
          className={`relative overflow-hidden flex-1 h-8 px-3 text-xs cut-corners transition-colors font-medium flex items-center justify-center text-[var(--accent-fg)] disabled:opacity-100 disabled:cursor-not-allowed cursor-pointer ${
            isDelete
              ? 'bg-red-500/90 hover:bg-red-500'
              : 'bg-[var(--accent)] hover:bg-[var(--accent-hover,var(--accent))]'
          }`}
        >
          {running && (isDeploy || isPromote) && (
            <span
              aria-hidden
              className="absolute inset-y-0 left-0 transition-[width] duration-300 ease-out"
              style={{ backgroundColor: 'color-mix(in srgb, var(--accent-fg) 24%, transparent)', width: `${Math.round(progress * 100)}%` }}
            />
          )}
          <span className="relative">
            {running
              ? isDelete
                ? 'Deleting…'
                : `${isDeploy ? 'Deploying' : 'Promoting'}… ${Math.round(progress * 100)}%`
              : submitText}
          </span>
        </button>
      </div>
    </ConfirmModalShell>
  );
}

// ─── Create-environment modal (Studio only) ────────────────────────────────

interface CreateEnvironmentModalProps {
  onCancel: () => void;
  onCreate: (name: string) => Promise<boolean>;
  error: string | null;
}

function CreateEnvironmentModal({ onCancel, onCreate, error }: CreateEnvironmentModalProps) {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [submitting, onCancel]);

  const handleSubmit = async () => {
    const trimmed = name.trim().toLowerCase();
    if (!trimmed) return;
    setSubmitting(true);
    const ok = await onCreate(trimmed);
    if (!ok) setSubmitting(false);
  };

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 99999 }}
      onClick={submitting ? undefined : onCancel}
    >
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="absolute inset-0 bg-black/40"
      />
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.15 }}
        className="relative w-80 bg-[var(--bg-surface)] cut-corners cut-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border-light)]">
          <h3 className="text-xs font-bold text-[var(--text-primary)]">New staging environment</h3>
          <button
            onClick={onCancel}
            disabled={submitting}
            className="p-1 hover:bg-[var(--bg-hover)] cut-corners cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--text-secondary)]">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="p-3 flex flex-col gap-3">
          <p className="text-xs text-[var(--text-secondary)]">
            Lowercase letters, numbers, and dashes only. 1-32 characters.
          </p>
          <input
            type="text"
            autoFocus
            value={name}
            placeholder="qa, preview, client-march…"
            maxLength={32}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) void handleSubmit(); }}
            className="w-full h-8 px-3 text-xs bg-[var(--grid-line)] border border-[var(--control-border)] focus:border-[var(--accent)] text-[var(--text-primary)] cut-corners cut-border focus:[--cut-border-color:var(--accent)] focus:outline-none"
          />
          {error && <p className="text-[11px] text-red-400">{error}</p>}
          <div className="flex items-center gap-2">
            <button
              onClick={onCancel}
              disabled={submitting}
              className="flex-1 h-8 text-xs font-medium text-[var(--text-primary)] bg-[var(--grid-line)] hover:bg-[var(--bg-hover)] cut-corners cursor-pointer disabled:opacity-30"
            >
              Cancel
            </button>
            <button
              onClick={() => { void handleSubmit(); }}
              disabled={submitting || !name.trim()}
              className="flex-1 h-8 text-xs font-medium text-[var(--accent-fg)] bg-[var(--accent)] hover:opacity-90 cut-corners cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'Creating…' : 'Create'}
            </button>
          </div>
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}
