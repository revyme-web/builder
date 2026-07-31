// CollaboratorsSection.tsx — Bottom-of-LeftMenu stack matching the old
// builder's design exactly:
//
//      [ + ]            ← opens the CollaboratorsModal (invite)
//      [ collab 1 ]     ← remote user avatar (click → pan to cursor)
//      [ collab 2 ]     ← …
//      …
//      [ ME 🟢 ]        ← current user avatar with pulsing green
//                          "connected" indicator
//
// Avatars are 28×28 rounded-full circles with a `#555` 1px border,
// spaced apart in a vertical column (`mt-2` between items). The pulse
// dot is an emerald 8×8 with an animate-ping halo at 75 % opacity,
// planted bottom-right, shown on every connected user (each entry in
// `remoteUsers` is connected) and on self.

import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { userAtom } from '@/backend/user-store';
import { useCollaboration } from '@/canvas/collab/CollaborationProvider';
import { trace } from '@/shared/debug-trace';

interface Props {
  onAddClick: () => void;
  /** LeftMenu's floating-tooltip handlers — the same ones the icon
   *  buttons use, so collaborator avatars get the identical hover chip
   *  (name to the right) instead of the native browser `title`. */
  onTooltipEnter: (key: string, label: string, el: HTMLElement) => void;
  onTooltipLeave: () => void;
}

export default function CollaboratorsSection({
  onAddClick,
  onTooltipEnter,
  onTooltipLeave,
}: Props) {
  const user = useAtomValue(userAtom);
  const { remoteUsers, self, cursors } = useCollaboration();

  const userName = user?.name ?? user?.email?.split('@')[0] ?? 'You';
  // Owner color comes from the join ack (self.color). Falls back to
  // the brand green so the avatar doesn't render with a transparent
  // background before the socket connects.
  const ownColor = self?.color ?? '#0d9668';

  // One avatar per unique person. The server tracks presence per SOCKET,
  // so a user with several tabs open shows up as multiple `remoteUsers`
  // entries — same `id`, different `socketId` (the provider only dedupes
  // by `socketId`). Collapse them by `id`, and drop the current user's
  // own other tabs entirely — `self` is already rendered separately at
  // the bottom, so those would just be duplicates of self.
  const selfId = self?.id ?? user?.id ?? null;
  const uniqueRemoteUsers = useMemo(() => {
    const seen = new Set<string>();
    const out: typeof remoteUsers = [];
    for (const c of remoteUsers) {
      if (selfId && c.id === selfId) continue;
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
    return out;
  }, [remoteUsers, selfId]);

  trace.fn('CollaboratorsSection.render', {
    remoteUsers: remoteUsers.length,
    uniqueRemoteUsers: uniqueRemoteUsers.length,
  });

  return (
    <div className="flex flex-col items-center">
      {/* + button at the top — opens the invite modal. */}
      <button
        onClick={onAddClick}
        onMouseEnter={(e) => onTooltipEnter('collab-add', 'Add collaborators', e.currentTarget)}
        onMouseLeave={onTooltipLeave}
        className="w-[28px] h-[28px] rounded-full flex items-center justify-center bg-[var(--bg-hover)] hover:bg-[var(--grid-line)] transition-colors border border-[#555] cursor-pointer"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path
            d="M7 3V11M3 7H11"
            stroke="currentColor"
            className="text-[var(--text-primary)]"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {/* Remote collaborators — stacked between + and self. De-duplicated
          by user id so multiple tabs of one person show a single avatar. */}
      {uniqueRemoteUsers.map((c) => {
        const hasCursor = cursors.has(c.id);
        return (
          <div key={c.id} className="relative mt-2">
            <button
              type="button"
              onClick={() => {
                // pan-to-cursor — v1 logs the intent so we can wire
                // the camera helper as a follow-up without changing
                // this surface. The cursor coords are already
                // canvas-root-relative; the camera command needs
                // them in canvas-content space, which involves the
                // active viewport's pan/zoom.
                if (!hasCursor) return;
                trace.action('collab:pan-to-cursor', { userId: c.id });
              }}
              onMouseEnter={(e) => onTooltipEnter(`collab-${c.id}`, c.name, e.currentTarget)}
              onMouseLeave={onTooltipLeave}
              className={`w-[28px] h-[28px] rounded-full flex items-center justify-center text-white text-[10px] font-bold border border-[#555] transition-all ${
                hasCursor ? 'cursor-pointer hover:scale-110' : 'opacity-70'
              }`}
              style={{ backgroundColor: c.avatar ? 'transparent' : c.color }}
            >
              {c.avatar ? (
                <img
                  src={c.avatar}
                  alt={c.name}
                  className="w-full h-full rounded-full object-cover"
                />
              ) : (
                getInitials(c.name)
              )}
            </button>
            {/* Remote users in `remoteUsers` are connected — show the dot. */}
            <ConnectedDot />
          </div>
        );
      })}

      {/* Current user avatar at the bottom with pulsing "connected" dot.
          Tooltip appends " (You)" so the user can tell their own avatar
          apart from a remote collaborator with the same first initial. */}
      {user && (
        <div className="relative mt-2">
          <div
            onMouseEnter={(e) => onTooltipEnter('collab-self', `${userName} (You)`, e.currentTarget)}
            onMouseLeave={onTooltipLeave}
            className="w-[28px] h-[28px] rounded-full flex items-center justify-center text-white text-[10px] font-bold border border-[#555]"
            style={{ backgroundColor: user.image ? 'transparent' : ownColor }}
          >
            {user.image ? (
              <img
                src={user.image}
                alt={userName}
                className="w-full h-full rounded-full object-cover"
              />
            ) : (
              getInitials(userName)
            )}
          </div>
          <ConnectedDot />
        </div>
      )}
    </div>
  );
}

/** Pulsing emerald "connected" indicator, planted at the avatar's
 *  bottom-right corner. Shown on every connected user (every entry in
 *  `remoteUsers` is, by definition, connected) and on self. */
function ConnectedDot() {
  return (
    <span className="absolute bottom-[1px] right-[1px] flex h-2 w-2 pointer-events-none">
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
      <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
    </span>
  );
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0] ?? '')
    .join('')
    .toUpperCase()
    .slice(0, 2);
}
