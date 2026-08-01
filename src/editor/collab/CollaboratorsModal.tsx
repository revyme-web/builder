// CollaboratorsModal.tsx — Pixel-for-pixel port of the old builder's
// `CollaboratorsModal.tsx`. Structure, copy, and class lists match
// the original so the muscle memory of returning users carries over
// 1:1.
//
// Two access paths into a site, surfaced in one list:
//   - OWNER       — always one row, top of list. Has its own color
//                   picker (writes `websites.owner_color`).
//   - WORKSPACE   — workspace members of the owning workspace. Shown
//                   with a "Workspace" suffix label, no color picker
//                   here (managed from workspace settings).
//   - COLLABORATOR — per-site invites. Full controls: change role,
//                   change color, remove via the ⋯ menu.
//
// Cloud-only — standalone mode short-circuits to a small placeholder.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CLOUD_ENABLED } from '@/shared/cloud-flag';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  listCollaborators,
  inviteCollaborator,
  removeCollaborator,
  updateCollaborator,
  type Collaborator,
  type SeatLimitDetails,
} from '@/backend/revyme-backend';
import { getProjectId } from '@/backend/project-id';
import { ConfirmModal } from '@/editor/overlays/settings-shared';
import { trace } from '@/shared/debug-trace';
import { useCollaboration } from '@/canvas/collab/CollaborationProvider';
import { useIsViewer } from '@/code/stores/viewer-mode-store';



interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export default function CollaboratorsModal({ isOpen, onClose }: Props) {
  if (typeof document === 'undefined') return null;

  return createPortal(
    <>
      <AnimatePresence>
        {isOpen && (
          <div className="fixed inset-0 z-[99999] flex items-center justify-center">
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="absolute inset-0 bg-black/50"
              onClick={onClose}
            />
            {/* Panel */}
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.2 }}
              className="relative w-[90%] max-w-sm rounded-lg shadow-2xl overflow-hidden bg-[var(--bg-surface)]"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-light)]">
                <h3 className="text-xs font-bold text-[var(--text-primary)]">Collaborators</h3>
                <button
                  onClick={onClose}
                  className="p-1 hover:bg-[var(--bg-hover)] rounded-md transition-colors"
                >
                  <X className="w-4 h-4 text-[var(--text-secondary)]" />
                </button>
              </div>

              {/* Body */}
              {CLOUD_ENABLED ? <CloudBody /> : <StandaloneBody />}
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>,
    document.body,
  );
}

// ─── Standalone placeholder ────────────────────────────────────────────────

function StandaloneBody() {
  return (
    <div className="p-4 space-y-2">
      <p className="text-[11px] text-[var(--text-primary)]">
        Live collaboration requires Revyme Cloud.
      </p>
      <p className="text-[10px] text-[var(--text-tertiary)] leading-relaxed">
        Sign in to your Revyme account to invite editors and viewers to this site.
      </p>
    </div>
  );
}

// ─── Cloud body ────────────────────────────────────────────────────────────

function CloudBody() {
  const websiteId = useMemo(() => getProjectId(), []);
  // Broadcasts a collaborator color change to the room + updates the
  // shared color store so comments / indicators / cursors recolor live.
  const { sendColorChange } = useCollaboration();
  // Viewers get a read-only roster — no invite form, no per-member
  // role/remove menu. They can see who's on the site, nothing else.
  const isViewer = useIsViewer();
  const [rows, setRows] = useState<Collaborator[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Form state
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'editor' | 'viewer'>('editor');
  const [isRoleDropdownOpen, setIsRoleDropdownOpen] = useState(false);
  const [inviting, setInviting] = useState(false);

  // Per-row action state
  const [updatingColor, setUpdatingColor] = useState<string | null>(null);
  const [updatingRole, setUpdatingRole] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [openCollabDropdown, setOpenCollabDropdown] = useState<string | null>(null);
  const [openRoleSubmenu, setOpenRoleSubmenu] = useState<string | null>(null);
  const [dropdownPosition, setDropdownPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [confirmRemove, setConfirmRemove] = useState<{ userId: string; userName: string } | null>(null);
  // When the backend returns 402 SEAT_LIMIT we open a typed modal with
  // a "Buy seat" CTA pointing at the right workspace. Set on the action
  // that triggered it; cleared on close. The inline red banner is kept
  // for OTHER 400/403 errors but is bypassed for the seat-limit case.
  const [seatLimit, setSeatLimit] = useState<SeatLimitDetails | null>(null);

  // Owner identity — used to decide whether to show owner-only chrome
  // (invite form, color pickers, ⋯ menus). The current viewer might be
  // a workspace admin or a per-site editor with no manage rights.
  // We can't always tell from the modal alone; in v1 we treat anyone
  // who can see the modal as a candidate manager and let the backend
  // 403 invalid actions. Owner row marker is what we use to anchor
  // "is this me?" — see `currentUserIsOwner` below.
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listCollaborators(websiteId);
      setRows(list);
    } finally {
      setLoading(false);
    }
  }, [websiteId]);

  useEffect(() => { reload(); }, [reload]);

  // Close role dropdown on outside click — same pattern as the old
  // builder: a document-level mousedown handler that fires after the
  // popper toggles its own state.
  useEffect(() => {
    if (!isRoleDropdownOpen) return;
    const handler = () => setIsRoleDropdownOpen(false);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [isRoleDropdownOpen]);

  // Close the ⋯ menu on any click outside it. The menu is portaled to
  // <body>, but the modal content stops click propagation — so a plain
  // bubble-phase document listener never sees clicks made inside the
  // modal, and the menu stayed open. Listening in the CAPTURE phase
  // bypasses that: the handler runs before any stopPropagation and
  // closes unless the click landed inside the menu (`[data-collab-dropdown]`).
  useEffect(() => {
    if (!openCollabDropdown) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-collab-dropdown]')) return;
      setOpenCollabDropdown(null);
      setOpenRoleSubmenu(null);
    };
    document.addEventListener('click', handler, true);
    return () => document.removeEventListener('click', handler, true);
  }, [openCollabDropdown]);

  // ─── Actions ───────────────────────────────────────────────────────────

  const handleInvite = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = inviteEmail.trim();
      if (!trimmed) return;
      setInviting(true);
      setError('');
      trace.action('collab-modal:invite', { email: trimmed, role: inviteRole });
      const result = await inviteCollaborator(websiteId, trimmed, inviteRole);
      if (!result.ok) {
        // 402 + structured seat-limit details → open the Buy Seat
        // confirm modal instead of the inline red banner. Other failures
        // (400, 403, 500) fall through to the banner.
        if (result.seatLimit) {
          setSeatLimit(result.seatLimit);
        } else {
          setError(result.error ?? 'Failed to invite');
        }
        setInviting(false);
        return;
      }
      setInviteEmail('');
      setInviting(false);
      await reload();
    },
    [inviteEmail, inviteRole, websiteId, reload],
  );

  const handleUpdateColor = useCallback(
    async (userId: string, color: string) => {
      setUpdatingColor(userId);
      setError('');
      const result = await updateCollaborator(websiteId, userId, { color });
      if (!result.ok) {
        setError(result.error ?? 'Failed to update color');
      } else {
        // Persisted OK — broadcast so every live surface (comment
        // avatars, header/menu circles, remote cursors) recolors
        // immediately, here and for online teammates.
        sendColorChange(userId, color);
      }
      setUpdatingColor(null);
      await reload();
    },
    [websiteId, reload, sendColorChange],
  );

  const handleUpdateRole = useCallback(
    async (userId: string, role: 'editor' | 'viewer') => {
      setUpdatingRole(userId);
      setError('');
      const result = await updateCollaborator(websiteId, userId, { role });
      if (!result.ok) {
        if (result.seatLimit) {
          setSeatLimit(result.seatLimit);
        } else {
          setError(result.error ?? 'Failed to update role');
        }
      }
      setUpdatingRole(null);
      setOpenCollabDropdown(null);
      setOpenRoleSubmenu(null);
      await reload();
    },
    [websiteId, reload],
  );

  const handleRemoveConfirm = useCallback(async () => {
    if (!confirmRemove) return;
    const userId = confirmRemove.userId;
    setRemoving(userId);
    setError('');
    const result = await removeCollaborator(websiteId, userId);
    if (!result.ok) setError(result.error ?? 'Failed to remove');
    setRemoving(null);
    setConfirmRemove(null);
    await reload();
  }, [confirmRemove, websiteId, reload]);

  return (
    <>
      <div className="p-4 space-y-4">
        {/* Invite form — hidden entirely for viewers (read-only roster). */}
        {!isViewer && (
        <div>
          <p className="text-[10px] text-[var(--text-tertiary)] mb-2 uppercase tracking-wider font-medium">
            Invite by email
          </p>
          <form onSubmit={handleInvite} className="flex gap-2">
            <input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="colleague@example.com"
              className="flex-1 min-w-0 px-3 py-2 text-[11px] bg-[var(--bg-canvas)] border border-[var(--border-light)] rounded-md text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] placeholder:opacity-50 focus:outline-none focus:border-[var(--border-focus)] transition-colors"
              disabled={inviting}
            />
            <div className="relative">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsRoleDropdownOpen(!isRoleDropdownOpen);
                }}
                disabled={inviting}
                className="flex items-center gap-1.5 px-2.5 py-2 text-[11px] bg-[var(--bg-canvas)] border border-[var(--border-light)] rounded-md text-[var(--text-primary)] hover:border-[var(--border-focus)] focus:outline-none focus:border-[var(--border-focus)] transition-colors cursor-pointer disabled:opacity-50"
              >
                <span className="capitalize">{inviteRole}</span>
                <ChevronDown
                  className={`w-3 h-3 text-[var(--text-tertiary)] transition-transform ${
                    isRoleDropdownOpen ? 'rotate-180' : ''
                  }`}
                />
              </button>
              {isRoleDropdownOpen && (
                <div className="absolute top-full left-0 mt-1 w-full bg-[var(--bg-surface)] border border-[var(--border-light)] rounded-md shadow-lg overflow-hidden z-10">
                  <button
                    type="button"
                    onClick={() => {
                      setInviteRole('editor');
                      setIsRoleDropdownOpen(false);
                    }}
                    className={`w-full px-2.5 py-1.5 text-[11px] text-left hover:bg-[var(--bg-hover)] transition-colors ${
                      inviteRole === 'editor'
                        ? 'text-[var(--accent-text)] bg-[var(--bg-hover)]'
                        : 'text-[var(--text-primary)]'
                    }`}
                  >
                    Editor
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setInviteRole('viewer');
                      setIsRoleDropdownOpen(false);
                    }}
                    className={`w-full px-2.5 py-1.5 text-[11px] text-left hover:bg-[var(--bg-hover)] transition-colors ${
                      inviteRole === 'viewer'
                        ? 'text-[var(--accent-text)] bg-[var(--bg-hover)]'
                        : 'text-[var(--text-primary)]'
                    }`}
                  >
                    Viewer
                  </button>
                </div>
              )}
            </div>
            <button
              type="submit"
              disabled={inviting || !inviteEmail.trim()}
              className="px-3 py-2 text-[11px] font-medium text-[var(--accent-fg)] bg-[var(--accent)] rounded-md hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 transition-colors"
            >
              {inviting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Invite'}
            </button>
          </form>
        </div>
        )}

        {/* Error message */}
        {error && (
          <div className="px-3 py-2 text-[10px] text-red-400 bg-red-500/10 rounded-md border border-red-500/20">
            {error}
          </div>
        )}

        {/* Members list */}
        <div>
          <p className="text-[10px] text-[var(--text-tertiary)] mb-2 uppercase tracking-wider font-medium">
            Members
          </p>

          {loading ? (
            <div className="space-y-1">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="flex items-center gap-2.5 px-2.5 py-2 rounded-md bg-[var(--bg-canvas)] animate-pulse"
                >
                  <div className="w-7 h-7 rounded-full bg-white/10 flex-shrink-0" />
                  <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                    <div className="h-3 bg-white/10 rounded w-20" />
                    <div className="h-2.5 bg-white/5 rounded w-12" />
                  </div>
                  <div className="w-5 h-5 rounded-full bg-white/10 flex-shrink-0" />
                </div>
              ))}
            </div>
          ) : rows.length === 0 ? (
            <p className="text-center py-4 text-[10px] text-[var(--text-tertiary)]">
              No collaborators yet
            </p>
          ) : (
            <div className="space-y-1 max-h-[240px] overflow-y-auto">
              {rows.map((row) => (
                <MemberRow
                  key={row.user_id}
                  row={row}
                  isViewer={isViewer}
                  updatingColor={updatingColor === row.user_id}
                  updatingRole={updatingRole === row.user_id}
                  removing={removing === row.user_id}
                  openDropdown={openCollabDropdown === row.user_id}
                  onColorChange={(c) => handleUpdateColor(row.user_id, c)}
                  onOpenDropdown={(rect) => {
                    const MENU_W = 160;
                    setDropdownPosition({
                      top: rect.bottom + 4,
                      // Left-align the menu with the ⋯ button so it
                      // opens to the right; clamp so it never runs
                      // off-screen.
                      left: Math.min(rect.left, window.innerWidth - MENU_W - 8),
                    });
                    setOpenCollabDropdown(row.user_id);
                    setOpenRoleSubmenu(null);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Collaborator dropdown menu — portaled */}
      {openCollabDropdown && createPortal(
        <CollaboratorDropdown
          row={rows.find((r) => r.user_id === openCollabDropdown) ?? null}
          position={dropdownPosition}
          openRoleSubmenu={openRoleSubmenu === openCollabDropdown}
          setOpenRoleSubmenu={(open) => setOpenRoleSubmenu(open ? openCollabDropdown : null)}
          onChangeRole={(role) => handleUpdateRole(openCollabDropdown, role)}
          onRemove={() => {
            const r = rows.find((x) => x.user_id === openCollabDropdown);
            if (r) {
              setConfirmRemove({
                userId: r.user_id,
                userName: r.name ?? r.email.split('@')[0] ?? r.email,
              });
            }
            setOpenCollabDropdown(null);
          }}
        />,
        document.body,
      )}

      {/* Seat-limit modal — opens when the backend returns 402 SEAT_LIMIT
          on invite or PATCH(viewer→editor). Routes the user to the
          workspace Invite tab in the cloud dashboard where seats are
          managed. Uses window.location.origin so the link works in
          dev (localhost:3001) and prod (revyme.com) without env config. */}
      <ConfirmModal
        isOpen={!!seatLimit}
        onCancel={() => setSeatLimit(null)}
        onConfirm={() => {
          if (!seatLimit?.workspaceId) {
            setSeatLimit(null);
            return;
          }
          const url = `${window.location.origin}/dashboard?ws=${encodeURIComponent(
            seatLimit.workspaceId,
          )}&view=${encodeURIComponent('settings:invite')}`;
          trace.action('collab-modal:buy-seat-clicked', {
            workspaceId: seatLimit.workspaceId,
            limit: seatLimit.limit,
            currentCount: seatLimit.currentCount,
          });
          window.open(url, '_blank', 'noopener,noreferrer');
          setSeatLimit(null);
        }}
        title="Workspace is at editor capacity"
        message={
          seatLimit?.limit === 0
            ? 'No editor seats purchased yet. Buy a seat in workspace settings to invite editors.'
            : `${seatLimit?.currentCount ?? 0} of ${seatLimit?.limit ?? 0} seats used. Add a seat in workspace settings, or demote a current editor to viewer.`
        }
        confirmText="Buy seat"
        cancelText="Cancel"
        variant="default"
      />

      {/* Remove-collaborator confirm — shared design with the seat-limit
          modal above (same portal/fade/header/footer chrome from
          settings-shared.tsx). `variant: 'danger'` gives the red primary
          button matching the destructive intent. */}
      <ConfirmModal
        isOpen={!!confirmRemove}
        onCancel={() => setConfirmRemove(null)}
        onConfirm={handleRemoveConfirm}
        title="Remove Collaborator?"
        message={
          confirmRemove
            ? `Are you sure you want to remove ${confirmRemove.userName}? They will lose access to this project.`
            : ''
        }
        confirmText="Remove"
        cancelText="Cancel"
        variant="danger"
        isLoading={confirmRemove ? removing === confirmRemove.userId : false}
      />
    </>
  );
}

// ─── Member row ────────────────────────────────────────────────────────────

function MemberRow({
  row,
  isViewer,
  updatingColor,
  updatingRole,
  removing,
  openDropdown,
  onColorChange,
  onOpenDropdown,
}: {
  row: Collaborator;
  /** Read-only roster mode — no ⋯ menu, color shown as a static dot. */
  isViewer: boolean;
  updatingColor: boolean;
  updatingRole: boolean;
  removing: boolean;
  openDropdown: boolean;
  onColorChange: (color: string) => void;
  onOpenDropdown: (rect: DOMRect) => void;
}) {
  const isOwner = row.source === 'owner';
  const isWorkspace = row.source === 'workspace';
  const isPerSite = row.source === 'collaborator';
  const isPending = row.source === 'pending';
  const initials = getInitials(row.name, row.email);

  // Owner row uses the older `bg-[var(--bg-canvas)]` always-on chrome
  // (no hover treatment) since the owner is "special". Other rows fall
  // back to the hover-only highlight from the old builder. Workspace
  // rows match the per-site chrome so they read as members, just with
  // a different sub-label and no actions.
  const rowChrome = isOwner
    ? 'bg-[var(--bg-canvas)]'
    : 'hover:bg-[var(--bg-canvas)] transition-colors';

  return (
    <div className={`flex items-center gap-2.5 px-2.5 py-2 rounded-md group ${rowChrome}`}>
      {/* Avatar — owner uses solid bg-fill, others use bg + colored
          border-2 like the old builder. */}
      <div
        className={`w-7 h-7 rounded-full flex items-center justify-center text-white text-[10px] font-medium flex-shrink-0 ${
          isOwner ? '' : 'border-2'
        }`}
        style={
          isOwner
            ? { backgroundColor: row.avatar ? 'transparent' : row.color }
            : {
                backgroundColor: row.avatar ? 'transparent' : row.color,
                borderColor: row.avatar ? 'transparent' : row.color,
              }
        }
      >
        {row.avatar ? (
          <img
            src={row.avatar}
            alt={row.name ?? row.email}
            className="w-full h-full rounded-full object-cover"
          />
        ) : (
          initials
        )}
      </div>

      {/* Name + sublabel */}
      <div className="flex-1 min-w-0 flex flex-col justify-center">
        <span className="text-[11px] font-medium text-[var(--text-primary)] truncate leading-none">
          {row.name ?? row.email.split('@')[0] ?? row.email}
        </span>
        <span className="text-[10px] text-[var(--text-tertiary)] opacity-60 capitalize leading-none mt-0.5">
          {isOwner
            ? 'Owner'
            : isWorkspace
              ? 'Workspace'
              : isPending
                ? `Pending · ${row.role}`
                : row.role}
        </span>
      </div>

      {/* Right-side actions */}
      <div className="flex items-center gap-1.5">
        {/* ⋯ menu — per-site rows only (owner can't be removed via this
            path, workspace rows are managed in workspace settings).
            Hidden for viewers — their roster is read-only. */}
        {isPerSite && !isViewer && (
          <div className="relative">
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (openDropdown) return;
                onOpenDropdown(e.currentTarget.getBoundingClientRect());
              }}
              disabled={removing || updatingRole}
              className="p-1 mr-1 rounded text-[var(--text-secondary)] opacity-60 group-hover:opacity-100 hover:text-[var(--text-primary)] hover:bg-white/5 transition-all"
            >
              {removing || updatingRole ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <MoreHorizontal className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        )}

        {/* Color — owner + per-site rows (workspace rows hide it because
            their color is workspace-managed). Viewers see a static dot;
            editors get the color picker. */}
        {(isOwner || isPerSite) && (
          isViewer ? (
            <div
              className="w-5 h-5 rounded-full flex-shrink-0"
              style={{ backgroundColor: row.color }}
            />
          ) : (
            <label
              className="w-5 h-5 rounded-full flex-shrink-0 cursor-pointer hover:ring-2 hover:ring-white/30 transition-all relative overflow-hidden"
              style={{ backgroundColor: row.color }}
              title="Change color"
            >
              <input
                type="color"
                defaultValue={row.color}
                onChange={(e) => onColorChange(e.target.value)}
                disabled={updatingColor}
                className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
              />
            </label>
          )
        )}
      </div>
    </div>
  );
}

// ─── ⋯ dropdown ────────────────────────────────────────────────────────────

function CollaboratorDropdown({
  row,
  position,
  openRoleSubmenu,
  setOpenRoleSubmenu,
  onChangeRole,
  onRemove,
}: {
  row: Collaborator | null;
  position: { top: number; left: number };
  openRoleSubmenu: boolean;
  setOpenRoleSubmenu: (open: boolean) => void;
  onChangeRole: (role: 'editor' | 'viewer') => void;
  onRemove: () => void;
}) {
  if (!row) return null;
  return (
    <div
      data-collab-dropdown
      className="fixed z-[9999999] min-w-[160px] bg-[var(--dropdown-bg)] border border-[var(--border-light)] rounded-[var(--radius-md)] shadow-lg p-1.5"
      style={{ top: position.top, left: position.left }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Change role */}
      <div
        className="relative"
        onMouseEnter={() => setOpenRoleSubmenu(true)}
        onMouseLeave={() => setOpenRoleSubmenu(false)}
      >
        <button className="w-full px-3 py-2 text-xs text-left flex items-center justify-between hover:bg-white/10 rounded-[var(--radius-sm)] transition-colors text-[var(--text-primary)]">
          <span>Change role</span>
          <ChevronRight className="w-3 h-3 text-[var(--text-secondary)]" />
        </button>
        {openRoleSubmenu && (
          <div
            className="absolute left-full -top-1.5 pl-3"
            onMouseEnter={() => setOpenRoleSubmenu(true)}
          >
            <div className="min-w-[120px] bg-[var(--dropdown-bg)] border border-[var(--border-light)] rounded-[var(--radius-md)] shadow-lg p-1.5">
              <button
                onClick={() => onChangeRole('editor')}
                className={`w-full px-3 py-2 text-xs text-left rounded-[var(--radius-sm)] transition-colors text-[var(--text-primary)] ${
                  row.role === 'editor' ? 'bg-[var(--bg-hover)]' : 'hover:bg-white/10'
                }`}
              >
                Editor
              </button>
              <button
                onClick={() => onChangeRole('viewer')}
                className={`w-full px-3 py-2 text-xs text-left rounded-[var(--radius-sm)] transition-colors text-[var(--text-primary)] ${
                  row.role === 'viewer' ? 'bg-[var(--bg-hover)]' : 'hover:bg-white/10'
                }`}
              >
                Viewer
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Remove */}
      <button
        onClick={onRemove}
        className="w-full px-3 py-2 text-xs text-left text-[var(--text-primary)] hover:bg-white/10 rounded-[var(--radius-sm)] transition-colors"
      >
        Remove
      </button>
    </div>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function getInitials(name: string | null, email: string): string {
  if (name) {
    return name
      .split(' ')
      .map((n) => n[0] ?? '')
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }
  return (email[0] ?? '?').toUpperCase();
}

// ─── Inline icons ──────────────────────────────────────────────────────────
// Mirror the lucide-react glyphs the old builder used, inlined because
// Revyme doesn't pull in lucide. Stroke / fill conventions match
// lucide's defaults so swapping back is mechanical if/when lucide lands.

function X({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function Loader2({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

function ChevronDown({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function ChevronRight({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function MoreHorizontal({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </svg>
  );
}
