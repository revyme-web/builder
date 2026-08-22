// BackupsSection.tsx — Per-site snapshot list + restore UI.
//
// Plan-aware:
//   free  → see latest 1 row, "Restore live" only
//   lite  → see latest 3 rows, "Restore live" only
//   pro   → see all rows in last 7 days, "Restore live" only
//   studio → see all rows in last 30 days, "Restore live" + "Restore editor + live"
//
// The backend (services/snapshots.ts listSnapshots) does the plan-filtering;
// this component just renders whatever it gets, plus a tier-aware upsell footer.

import React, { useState, useEffect, useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { trace } from '@/shared/debug-trace';
import { Skeleton } from '@/editor/overlays/settings-shared';
import { settingsSectionAtom } from '@/code/stores/website-settings-store';
import { useSigmoidProgress } from '@/editor/hooks/useSigmoidProgress';
import { type DropdownMenuEntry } from '@/design-system/DropdownMenu';
import { ConfirmModalShell, ModalCancelButton, RowActionsMenu, useEscapeToClose } from './shared';

interface SnapshotCreatedBy {
  id: string;
  name: string;
  avatar: string | null;
}

interface SnapshotRow {
  id: string;
  website_id: string;
  kind: string;
  deploy_meta: string | null;
  created_at: string;
  /** Optional user-supplied label. When set, the row shows it as the
   *  primary identifier and the timestamp drops to subtitle. NULL =
   *  unnamed, the date is the primary identifier. */
  label: string | null;
  /** Who triggered the publish that created this snapshot. NULL on
   *  pre-migration rows or when the user was deleted. */
  created_by: SnapshotCreatedBy | null;
}

interface ListResponse {
  snapshots: SnapshotRow[];
  effectivePlan: 'free' | 'lite' | 'pro' | 'studio';
  /** ID of the snapshot currently deployed live. Used to render a "Live"
   *  badge on the matching row. NULL when the site has never published. */
  liveSnapshotId: string | null;
}

interface BackupsSectionProps {
  websiteId: string;
}

const PLAN_COPY = {
  free: { window: '1 backup', upsell: 'Upgrade to Pro for 7 days of backup history' },
  lite: { window: '3 backups', upsell: 'Upgrade to Pro for 7 days of backup history' },
  pro: { window: 'last 7 days', upsell: 'Upgrade to Studio for 30 days + editor restore' },
  studio: { window: 'last 30 days', upsell: null },
} as const;

export default function BackupsSection({ websiteId }: BackupsSectionProps) {
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ snap: SnapshotRow; target: 'live' | 'editor' | 'both' } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<SnapshotRow | null>(null);
  // Inline label editing: editingId tracks which row's label is open
  // for edit (null = none). draft holds the current input value while
  // the user is typing, separately from the persisted label so a
  // mid-edit refresh doesn't clobber their keystrokes.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  // Which row's Restore-dropdown is open. Single source of truth at the
  // parent so opening one row's menu closes any other already open.
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const setActiveSection = useSetAtom(settingsSectionAtom);

  const refresh = useCallback(async () => {
    if (!websiteId) return;
    trace.fn('backups-section:fetch', { websiteId });
    setLoading(true);
    try {
      const r = await fetch(`/api/snapshots?websiteId=${websiteId}`);
      if (r.ok) setData(await r.json());
    } catch (e) {
      trace.error('backups-section:fetch', e);
    } finally {
      setLoading(false);
    }
  }, [websiteId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Open the inline editor on a row. Pre-fills with the current label
  // so users can edit; empty draft means they're adding a new label.
  const startEdit = useCallback((s: SnapshotRow) => {
    setEditingId(s.id);
    setDraft(s.label ?? '');
  }, []);

  // Persist or clear the label. Empty trimmed value clears (sends null);
  // anything else trims and saves up to the schema cap (120 chars).
  // Optimistically updates the local state so the row reflects the new
  // label before the API round-trip resolves.
  const saveLabel = useCallback(async (snapId: string, raw: string) => {
    const trimmed = raw.trim();
    const next = trimmed.length === 0 ? null : trimmed.slice(0, 120);
    setEditingId(null);
    setDraft('');
    setData((prev) => prev ? {
      ...prev,
      snapshots: prev.snapshots.map((s) => s.id === snapId ? { ...s, label: next } : s),
    } : prev);
    try {
      trace.action('backups-section:save-label', { snapId, label: next });
      await fetch(`/api/snapshots/${snapId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: next }),
      });
    } catch (e) {
      trace.error('backups-section:save-label', e);
      // On failure, refresh from server to undo the optimistic update.
      refresh();
    }
  }, [refresh]);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setDraft('');
  }, []);

  // Delete a snapshot via DELETE /api/snapshots/:id (soft-delete on the
  // server — recoverable for 7 days before the prune cron hard-deletes).
  // Optimistically drops the row from local state so the list updates
  // immediately; refreshes from server on failure.
  const handleDelete = useCallback(async (snapId: string): Promise<boolean> => {
    trace.action('backups-section:delete', { snapId });
    setData((prev) => prev ? {
      ...prev,
      snapshots: prev.snapshots.filter((s) => s.id !== snapId),
    } : prev);
    try {
      const r = await fetch(`/api/snapshots/${snapId}`, { method: 'DELETE' });
      if (!r.ok) {
        trace.error('backups-section:delete-http', { status: r.status });
        await refresh();
        return false;
      }
      return true;
    } catch (e) {
      trace.error('backups-section:delete', e);
      await refresh();
      return false;
    }
  }, [refresh]);

  const handleRestore = useCallback(async (snap: SnapshotRow, target: 'live' | 'editor' | 'both') => {
    try {
      setRestoring(snap.id);
      trace.action('backups-section:restore', { snapId: snap.id, target });
      const r = await fetch(`/api/snapshots/${snap.id}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => null);
        trace.error('backups-section:restore-http', { status: r.status, err });
        alert(err?.error?.message ?? 'Restore failed');
        return false;
      }
      const result = await r.json();
      trace.action('backups-section:restored', result);
      return true;
    } catch (e) {
      trace.error('backups-section:restore', e);
      alert('Restore failed. Please try again.');
      return false;
    }
  }, []);

  if (!loading && !data) {
    return <p className="text-sm text-[var(--text-secondary)]">Couldn't load backups.</p>;
  }

  // While the initial fetch is in flight, fall back to the "free" copy
  // (smallest window — looks right whatever the real plan ends up
  // being) so the header description renders without flicker, and the
  // upsell stays hidden. snapshots stays empty and the list area below
  // takes over with skeleton rows.
  const snapshots = data?.snapshots ?? [];
  const effectivePlan = data?.effectivePlan ?? 'free';
  const copy = PLAN_COPY[effectivePlan];
  const isStudio = effectivePlan === 'studio';

  // Pin the currently-deployed snapshot at the top of the section. In 30
  // days (Studio) the list can be dozens of rows, so making "what's live
  // right now?" the very first thing the user sees matters more than
  // strict chronological order. The live row STILL appears in its
  // chronological position in the full list below — duplicated by design
  // so the user can see WHEN it was published relative to other versions.
  const liveSnap = data?.liveSnapshotId
    ? snapshots.find((s) => s.id === data?.liveSnapshotId) ?? null
    : null;
  const latestSnap = snapshots[0] ?? null; // API returns newest-first
  // "From backup" = the deployed snapshot isn't the most-recent publish.
  // Drives the amber color treatment so the user knows their live site
  // doesn't reflect their latest editor work.
  const isLiveFromBackup = !!liveSnap && !!latestSnap && liveSnap.id !== latestSnap.id;

  // Row renderer — used by both the pinned "Currently live" section and
  // the "All publishes" list. The two callsites only differ in framing;
  // the row itself is identical so the user sees the same content twice
  // (once at the top, once in chronological position).
  const renderRow = (s: SnapshotRow) => {
    const meta = s.deploy_meta ? (() => {
      try { return JSON.parse(s.deploy_meta!); } catch { return null; }
    })() : null;
    const publisher = s.created_by?.name ?? 'Unknown user';
    const isLive = data?.liveSnapshotId === s.id;
    const createdDate = new Date(s.created_at);
    // Two-line right-side date: "Fri, May 16, 2026" / "4:58 PM".
    const datePart = createdDate.toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    const timePart = createdDate.toLocaleString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
    const dateStr = `${datePart}, ${timePart}`;
    // Display name: user-set label OR auto-default "Backup from <date>".
    // The DB column stays null for default-named rows so clearing the
    // input restores the default (no need for an explicit reset button).
    const displayName = s.label ?? `Backup from ${dateStr}`;
    return (
      <li
        key={s.id}
        className={`flex items-center justify-between gap-3 py-3 border-b border-[var(--border-light)] last:border-b-0 ${
          isLive ? 'pl-3 -ml-3 border-l-2 border-l-emerald-500/60' : ''
        }`}
      >
        <div className="min-w-0 flex items-center gap-3 flex-1">
          <UserAvatar user={s.created_by} />
          <div className="min-w-0 flex-1">
            {/* Name is the row's primary identifier on the left.
                Click to inline-edit. Empty save -> back to default. */}
            {editingId === s.id ? (
              <input
                type="text"
                autoFocus
                value={draft}
                placeholder={`Backup from ${dateStr}`}
                maxLength={120}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => saveLabel(s.id, draft)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    saveLabel(s.id, draft);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelEdit();
                  }
                }}
                // field-sizing:content auto-fits the input width to the
                // typed text (modern Chrome/Edge/Safari). Falls back to
                // a sensible min/max via ch units in older browsers.
                style={{ fieldSizing: 'content' } as React.CSSProperties}
                className="text-sm font-medium text-[var(--text-primary)] bg-white/5 border border-[var(--accent)] rounded px-1.5 py-0 leading-snug focus:outline-none min-w-[14ch] max-w-full"
              />
            ) : (
              <button
                type="button"
                onClick={() => startEdit(s)}
                className="group inline-flex items-center gap-1.5 text-sm font-medium text-[var(--text-primary)] max-w-full hover:text-[var(--accent-text)] transition-colors cursor-pointer"
                title="Click to rename. Clear to reset to default."
              >
                <span className="truncate">{displayName}</span>
                {/* Pencil affordance — always visible but subtle (tertiary
                    color) so it doesn't compete with the name. Brightens
                    when the user hovers the row's name button. */}
                <svg
                  width="12" height="12" viewBox="0 0 24 24"
                  className="flex-shrink-0 text-[var(--text-primary)] group-hover:text-[var(--accent-text)] transition-colors"
                >
                  <path d="M0 0h24v24H0z" fill="none" />
                  <path
                    fill="currentColor"
                    d="M7.243 17.997H3v-4.243L14.435 2.319a1 1 0 0 1 1.414 0l2.829 2.828a1 1 0 0 1 0 1.415zm-4.243 2h18v2H3z"
                  />
                </svg>
              </button>
            )}
            <p className="text-xs text-[var(--text-secondary)] truncate">
              Published by <b className="font-semibold text-[var(--text-primary)]">{publisher}</b>
              {meta?.subdomain ? <> to {meta.subdomain}</> : null}
            </p>
          </div>
        </div>
        {/* Right cluster: actual created_at (always shown, anchor of the
            row regardless of name) + Restore button or Live badge. Both
            buttons share the same width so the right edge lines up
            across all rows. */}
        <div className="flex items-center gap-3 flex-shrink-0">
          <div className="text-right leading-tight tabular-nums">
            <div className="text-xs font-medium text-[var(--text-primary)]">{datePart}</div>
            <div className="text-[10px] text-[var(--text-secondary)] mt-0.5">{timePart}</div>
          </div>
          {isLive ? (
            <span className="inline-flex items-center justify-center gap-1.5 w-[110px] h-[30px] cut-corners cut-border text-[11px] font-semibold border bg-emerald-500/15 text-emerald-400 border-emerald-500/30">
              <span className="relative flex w-1.5 h-1.5">
                <span className="absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping bg-emerald-400" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400" />
              </span>
              {isLiveFromBackup ? 'Live (backup)' : 'Live'}
            </span>
          ) : (
            <RowActionsMenu
              items={buildActionItems({
                isStudio,
                onRestore: (target) => {
                  setOpenMenuId(null);
                  setConfirm({ snap: s, target });
                },
                onDelete: () => {
                  setOpenMenuId(null);
                  setDeleteConfirm(s);
                },
              })}
              isOpen={openMenuId === s.id}
              disabled={restoring === s.id}
              onToggle={() => setOpenMenuId((cur) => cur === s.id ? null : s.id)}
              onClose={() => setOpenMenuId(null)}
              disabledOpacity="50"
            />
          )}
        </div>
      </li>
    );
  };

  return (
    <div>
      {/* Header — title + window-of-history caption on the left, plan
          upsell as a small inline link on the right (instead of a
          full-width gradient banner). Same idiom as A/B detail page. */}
      <div className="flex items-start justify-between gap-3 pb-6 border-b border-[var(--border-light)]">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1">
            Backups
          </h3>
          <p className="text-xs text-[var(--text-secondary)]">
            Showing {copy.window} of publish history. Each row is a snapshot from a successful publish.
          </p>
        </div>
        {copy.upsell && (
          <button
            onClick={() => setActiveSection('plans')}
            className="flex-shrink-0 inline-flex items-center gap-1 text-xs font-medium text-[var(--accent-text)] hover:underline cursor-pointer"
          >
            {copy.upsell} →
          </button>
        )}
      </div>

      {loading ? (
        <ul>
          {[0, 1, 2].map(i => (
            <li
              key={i}
              className="flex items-center justify-between gap-3 py-3 border-b border-[var(--border-light)] last:border-b-0"
            >
              <div className="flex items-center gap-3 flex-1">
                <Skeleton className="h-7 w-7 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3 w-32" />
                </div>
              </div>
              <Skeleton className="h-[30px] w-[110px] cut-corners" />
            </li>
          ))}
        </ul>
      ) : snapshots.length === 0 ? (
        <p className="py-6 text-sm text-[var(--text-secondary)]">
          No backups yet. Publish your site to create the first one.
        </p>
      ) : (
        <>
          {/* Pinned "Currently live" section — section label + the live
              row, separated from "All publishes" by a hairline. */}
          {liveSnap && (
            <div className="py-6 border-b border-[var(--border-light)]">
              <p className="text-[10px] font-semibold tracking-wider uppercase text-[var(--text-tertiary)] mb-3">
                Currently live
              </p>
              <ul>{renderRow(liveSnap)}</ul>
              {isLiveFromBackup && latestSnap && (
                <p className="mt-2 text-[11px] text-amber-400/90">
                  This is from a backup. This website's latest publish was {new Date(latestSnap.created_at).toLocaleString()}.
                </p>
              )}
            </div>
          )}

          <div className="py-6">
            <p className="text-[10px] font-semibold tracking-wider uppercase text-[var(--text-tertiary)] mb-3">
              All publishes
            </p>
            <ul>{snapshots.map(renderRow)}</ul>
          </div>
        </>
      )}

      <RestoreConfirmModal
        confirm={confirm}
        onCancel={() => setConfirm(null)}
        onRun={async (snap, target) => {
          const ok = await handleRestore(snap, target);
          if (!ok) {
            setRestoring(null);
            return;
          }
          // Notify the header dropdown that publish state changed.
          window.dispatchEvent(new Event('website-meta-changed'));
          if (target === 'editor' || target === 'both') {
            // Editor restore rewrote websites.json on the server — hard
            // reload so the editor re-fetches and drops local state.
            // Otherwise the local jotai state would clobber the restore
            // on the next autosave.
            window.location.reload();
          } else {
            // Live-only: keep the user in place, just refresh the list
            // so the "Live" badge moves to the row they just restored.
            setRestoring(null);
            setConfirm(null);
            await refresh();
          }
        }}
      />

      <DeleteConfirmModal
        snap={deleteConfirm}
        onCancel={() => setDeleteConfirm(null)}
        onConfirm={async () => {
          if (!deleteConfirm) return;
          await handleDelete(deleteConfirm.id);
          setDeleteConfirm(null);
        }}
      />
    </div>
  );
}

// ─── Actions dropdown items ────────────────────────────────────────────────
//
// The trigger button + dropdown itself is the shared `RowActionsMenu`
// (./shared.tsx); this just builds the per-row menu entries.

interface BuildActionItemsArgs {
  isStudio: boolean;
  onRestore: (target: 'live' | 'editor' | 'both') => void;
  onDelete: () => void;
}

function buildActionItems({ isStudio, onRestore, onDelete }: BuildActionItemsArgs): DropdownMenuEntry[] {
  const restoreItems: DropdownMenuEntry[] = isStudio
    ? [
        { id: 'restore-live', label: 'Restore live only', onClick: () => onRestore('live') },
        { id: 'restore-editor', label: 'Restore editor only', onClick: () => onRestore('editor') },
        { id: 'restore-both', label: 'Restore editor + live', onClick: () => onRestore('both') },
      ]
    : [
        { id: 'restore-live', label: 'Restore live', onClick: () => onRestore('live') },
      ];
  return [
    ...restoreItems,
    { type: 'separator' },
    { id: 'delete', label: 'Delete snapshot', onClick: onDelete },
  ];
}

// ─── Delete confirm modal ──────────────────────────────────────────────────
//
// Same NameInputModal-style compact dialog as the restore confirm — Cancel
// + destructive Delete button. Soft-delete on the backend (recoverable
// for 7 days), but explained to the user in plain terms.

interface DeleteConfirmModalProps {
  snap: SnapshotRow | null;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}

function DeleteConfirmModal({ snap, onCancel, onConfirm }: DeleteConfirmModalProps) {
  const [running, setRunning] = useState(false);

  // Escape closes — but only when not in-flight.
  useEscapeToClose(!!snap, running, onCancel);

  useEffect(() => { if (!snap) setRunning(false); }, [snap]);

  if (!snap) return null;

  const displayName = snap.label
    ?? `Backup from ${new Date(snap.created_at).toLocaleString()}`;

  return (
    <ConfirmModalShell open locked={running} onCancel={onCancel} title="Delete this snapshot?">
      <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
        <b className="font-semibold text-[var(--text-primary)]">{displayName}</b> will be removed
        from your list. Restoring isn't possible after delete — this
        snapshot won't appear in your backup history anymore.
      </p>
      <div className="flex items-center gap-2">
        <ModalCancelButton onClick={onCancel} disabled={running} />
        <button
          onClick={async () => {
            setRunning(true);
            try { await onConfirm(); } catch { setRunning(false); }
          }}
          disabled={running}
          className="flex-1 h-8 px-3 text-xs cut-corners font-medium flex items-center justify-center bg-red-500/90 hover:bg-red-500 text-white disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
        >
          {running ? 'Deleting…' : 'Delete snapshot'}
        </button>
      </div>
    </ConfirmModalShell>
  );
}

// ─── User avatar ───────────────────────────────────────────────────────────
//
// Image when the user has uploaded one, else a colored circle with the
// first initial. Matches the pattern from CommentChatPopup.

const AVATAR_PALETTE = [
  'oklch(0.6 0.18 25)',   // red
  'oklch(0.6 0.18 70)',   // orange
  'oklch(0.6 0.18 130)',  // green
  'oklch(0.6 0.18 200)',  // cyan
  'oklch(0.6 0.18 260)',  // blue
  'oklch(0.6 0.18 320)',  // magenta
];

function colorFromId(id: string): string {
  // Stable hash-by-codepoint-sum so the same user always gets the same
  // fallback color. Not crypto, just consistency.
  let sum = 0;
  for (let i = 0; i < id.length; i++) sum = (sum + id.charCodeAt(i)) % AVATAR_PALETTE.length;
  return AVATAR_PALETTE[sum];
}

interface UserAvatarProps {
  user: SnapshotCreatedBy | null;
}

function UserAvatar({ user }: UserAvatarProps) {
  if (!user) {
    return (
      <div
        className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 bg-[var(--grid-line)] text-[var(--text-tertiary)] text-[10px] font-semibold"
        title="Unknown user"
      >
        ?
      </div>
    );
  }
  const initial = (user.name || '?').charAt(0).toUpperCase();
  return (
    <div
      className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 overflow-hidden text-[11px] font-semibold text-white"
      style={{ backgroundColor: user.avatar ? 'transparent' : colorFromId(user.id) }}
      title={user.name}
    >
      {user.avatar ? (
        <img src={user.avatar} alt={user.name} className="w-full h-full object-cover" />
      ) : (
        <span>{initial}</span>
      )}
    </div>
  );
}

// ─── Restore confirm modal ─────────────────────────────────────────────────
//
// Compact design matching NameInputModal (the editor-wide pattern for small
// dialogs — create component, name keyframe, etc.). Locks during restore:
// no outside-click close, no Escape close, no X button while running, and
// the primary button renders a sigmoid progress fill identical to the
// publish dropdown in the header.

interface RestoreConfirmModalProps {
  confirm: { snap: SnapshotRow; target: 'live' | 'editor' | 'both' } | null;
  onCancel: () => void;
  onRun: (snap: SnapshotRow, target: 'live' | 'editor' | 'both') => Promise<void>;
}

function RestoreConfirmModal({ confirm, onCancel, onRun }: RestoreConfirmModalProps) {
  const [running, setRunning] = useState(false);
  const { progress, setProgress, startProgress, stopProgress } = useSigmoidProgress();

  // Reset progress whenever the modal opens fresh on a different snapshot.
  useEffect(() => {
    if (confirm) {
      setRunning(false);
      setProgress(0);
    } else {
      stopProgress();
    }
    return stopProgress;
  }, [confirm, stopProgress]);

  // Escape closes — but only while NOT running. The user can't bail mid-deploy.
  useEscapeToClose(!!confirm, running, onCancel);

  const handleRun = async () => {
    if (!confirm) return;
    setRunning(true);
    startProgress();
    try {
      await onRun(confirm.snap, confirm.target);
      // Snap to 100% on success — the same gesture publish uses.
      stopProgress();
      setProgress(1);
    } catch {
      // onRun handles its own error UX; here we just stop the bar.
      stopProgress();
      setRunning(false);
    }
  };

  const target = confirm?.target;
  const titleText =
    target === 'both' ? 'Restore editor and live site?'
    : target === 'editor' ? 'Restore editor?'
    : 'Restore live site?';

  const bodyText =
    target === 'both'
      ? 'Replaces your current editor state AND redeploys the live site to the snapshot version. Any unsaved edits in the editor will be lost.'
    : target === 'editor'
      ? 'Replaces your current editor state with the snapshot version. The live site is NOT redeployed — visitors keep seeing whatever is currently published. Any unsaved edits in the editor will be lost.'
    : 'Redeploys the live site to the snapshot version. Your editor state is untouched.';

  const submitText =
    target === 'both' ? 'Replace & redeploy'
    : target === 'editor' ? 'Replace editor'
    : 'Restore live';

  return (
    <ConfirmModalShell open={!!confirm} locked={running} onCancel={onCancel} title={titleText}>
      <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
        {bodyText}
      </p>

      <div className="flex items-center gap-2">
        <ModalCancelButton onClick={onCancel} disabled={running} />
        <button
          onClick={handleRun}
          disabled={running}
          className="relative overflow-hidden flex-1 h-8 px-3 text-xs cut-corners transition-colors font-medium flex items-center justify-center bg-[var(--accent)] hover:bg-[var(--accent-hover,var(--accent))] text-[var(--accent-fg)] disabled:opacity-100 disabled:bg-[var(--accent)] disabled:cursor-not-allowed cursor-pointer"
        >
          {running && (
            <span
              aria-hidden
              className="absolute inset-y-0 left-0 transition-[width] duration-300 ease-out"
              style={{ backgroundColor: 'color-mix(in srgb, var(--accent-fg) 24%, transparent)', width: `${Math.round(progress * 100)}%` }}
            />
          )}
          <span className="relative">
            {running
              ? `Restoring… ${Math.round(progress * 100)}%`
              : submitText}
          </span>
        </button>
      </div>
    </ConfirmModalShell>
  );
}
