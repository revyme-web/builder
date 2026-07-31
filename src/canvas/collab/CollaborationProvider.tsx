// CollaborationProvider.tsx — Socket.IO client + React context for the
// editor's live collaboration layer. Mounts at the App level.
//
// Lifecycle:
//   - On mount: connect to the Hono backend's Socket.IO endpoint (same
//     origin, /socket.io). Auth rides on the existing session cookie.
//   - emit `join { websiteId }` once connected. Server acks with the
//     full presence snapshot + current save-leader.
//   - Re-broadcast presence updates via context for cursor / indicator
//     consumers.
//   - On unmount / page hide: emit `leave` then disconnect.
//
// Cloud-only: standalone (no VITE_REVYME_CLOUD) skips the whole socket
// connection. The provider still renders its children — every collab
// consumer reads `isConnected` and treats `false` as "no remote users".

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { io, type Socket } from 'socket.io-client';
import { CLOUD_ENABLED } from '@/shared/cloud-flag';
import { getProjectId } from '@/backend/project-id';
import { projectFS, projectVersionAtom } from '@/code/project/project-fs';
import { syncQueueCode } from '@/code/mutation/mutation-queue';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { forceCanvasRender } from '@/canvas/node-ops';
import { setIsSaveLeader } from '@/backend/autosave';
import { useSetAtom, getDefaultStore } from 'jotai';
import { trace } from '@/shared/debug-trace';
import { listCollaborators } from '@/backend/revyme-backend';
import {
  setCollaboratorColors,
  updateCollaboratorColor,
} from '@/code/stores/collaborator-colors-store';
import type { ActiveUser, RemoteCursor, RemoteSelection } from './types';

const SYNC_DEBOUNCE_MS = 50;


const API_URL = ((import.meta as ImportMeta & { env: Record<string, string> }).env?.VITE_API_URL ?? '').replace(/\/$/, '');

interface CollaborationContextValue {
  /** True once the socket is open AND a `join` has been ack'd. */
  isConnected: boolean;
  /** Active users in the current website's room (excludes self). */
  remoteUsers: ActiveUser[];
  /** Self — null until the join ack lands. */
  self: ActiveUser | null;
  /** Lex-min userId — whoever auto-saves. */
  leader: string | null;
  /** Latest remote cursors, keyed by userId. Stale users (no update
   *  for >10s) are pruned. */
  cursors: Map<string, RemoteCursor>;
  /** Latest remote selections, keyed by userId. */
  selections: Map<string, RemoteSelection>;
  /** Broadcast a cursor position (canvas coords) — caller should
   *  throttle. Pass null to clear. */
  sendCursor: (pos: { x: number; y: number; page?: string } | null) => void;
  /** Broadcast the local selection. Caller should debounce. */
  sendSelection: (nodeIds: string[], page?: string) => void;
  /** Broadcast a collaborator color change (owner re-assigned a color
   *  in the CollaboratorsModal). Also updates the local color store
   *  synchronously so the change shows even offline. */
  sendColorChange: (userId: string, color: string) => void;
}

const STALE_CURSOR_MS = 10000;

const noopValue: CollaborationContextValue = {
  isConnected: false,
  remoteUsers: [],
  self: null,
  leader: null,
  cursors: new Map(),
  selections: new Map(),
  sendCursor: () => {},
  sendSelection: () => {},
  sendColorChange: () => {},
};

const CollaborationContext = createContext<CollaborationContextValue>(noopValue);

export function useCollaboration(): CollaborationContextValue {
  return useContext(CollaborationContext);
}

export function CollaborationProvider({ children }: { children: ReactNode }) {
  // In standalone mode, short-circuit with the no-op context so no
  // socket connection is ever attempted. Cheaper than rendering the
  // full provider with a dead socket.
  if (!CLOUD_ENABLED) {
    return <CollaborationContext.Provider value={noopValue}>{children}</CollaborationContext.Provider>;
  }
  return <CloudProvider>{children}</CloudProvider>;
}

function CloudProvider({ children }: { children: ReactNode }) {
  const websiteId = useMemo(() => getProjectId(), []);
  const socketRef = useRef<Socket | null>(null);
  // Bump after applying remote writes so jotai-derived atoms re-read
  // from projectFS. Mirrors `setBumpVersion` wired from Canvas.tsx for
  // local writes via `modifyProjectFile`.
  const bumpVersion = useSetAtom(projectVersionAtom);

  const [isConnected, setIsConnected] = useState(false);
  const [remoteUsers, setRemoteUsers] = useState<ActiveUser[]>([]);
  const [self, setSelf] = useState<ActiveUser | null>(null);
  const [leader, setLeader] = useState<string | null>(null);
  // Cursors + selections are stored in refs first, then mirrored into
  // state via a coalesced setState so we don't re-render on every
  // ~33ms cursor packet. The mirror is bumped at most once per RAF.
  const cursorsRef = useRef<Map<string, RemoteCursor>>(new Map());
  const selectionsRef = useRef<Map<string, RemoteSelection>>(new Map());
  const [cursors, setCursors] = useState<Map<string, RemoteCursor>>(cursorsRef.current);
  const [selections, setSelections] = useState<Map<string, RemoteSelection>>(selectionsRef.current);
  const pendingFlushRef = useRef<number | null>(null);

  // Schedule a coalesced state mirror on the next RAF. Multiple cursor
  // updates in a single frame batch into one render — keeps the
  // cursor-render loop at 60fps regardless of how many remote users
  // are scribbling at once.
  const scheduleFlush = useCallback(() => {
    if (pendingFlushRef.current !== null) return;
    pendingFlushRef.current = requestAnimationFrame(() => {
      pendingFlushRef.current = null;
      setCursors(new Map(cursorsRef.current));
      setSelections(new Map(selectionsRef.current));
    });
  }, []);

  // ─── Seed the collaborator-color store ─────────────────────────────────
  // The persisted per-website color for every person (owner + each
  // collaborator), incl. OFFLINE ones — so comment avatars resolve a
  // color even when the author isn't currently in the room. The live
  // socket user list only carries ONLINE users; this fills the gap.
  useEffect(() => {
    let cancelled = false;
    listCollaborators(websiteId).then((list) => {
      if (cancelled) return;
      setCollaboratorColors(
        list.map((c) => ({
          userId: c.user_id,
          color: c.color,
          name: c.name ?? c.email,
          avatar: c.avatar,
        })),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [websiteId]);

  // ─── Save-leader gate ──────────────────────────────────────────────────
  // Flip the autosave gate whenever our identity OR the elected leader
  // changes. Pre-join we treat ourselves as leader (fallback so an
  // editor that boots before the socket connects still persists).
  useEffect(() => {
    if (!isConnected) {
      setIsSaveLeader(true);
      return;
    }
    const meIsLeader = self?.id === leader && leader !== null;
    setIsSaveLeader(meIsLeader);
  }, [isConnected, self, leader]);

  // ─── Stale cursor sweep ─────────────────────────────────────────────────
  // Drop cursors that haven't seen an update in 10s — handles the case
  // where a remote user closes their tab without a clean disconnect
  // (e.g. browser crash, network drop).
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [userId, c] of cursorsRef.current.entries()) {
        if (now - ((c as RemoteCursor & { _ts?: number })._ts ?? 0) > STALE_CURSOR_MS) {
          cursorsRef.current.delete(userId);
          changed = true;
        }
      }
      if (changed) scheduleFlush();
    }, 2000);
    return () => clearInterval(interval);
  }, [scheduleFlush]);

  // ─── Socket lifecycle ──────────────────────────────────────────────────
  useEffect(() => {
    // The Socket.IO client honours `withCredentials` so the session
    // cookie rides on the handshake. Path defaults to `/socket.io`.
    const socket = io(API_URL || window.location.origin, {
      withCredentials: true,
      transports: ['websocket', 'polling'],
      // Reconnect aggressively for the first minute, then back off.
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      trace.action('collab:socket-connect', { socketId: socket.id });
      socket.emit(
        'join',
        { websiteId },
        (res: { ok: boolean; users?: ActiveUser[]; leader?: string | null; error?: string }) => {
          if (!res?.ok) {
            trace.error('collab:join-failed', { error: res?.error });
            return;
          }
          setIsConnected(true);
          const me = res.users?.find((u) => u.socketId === socket.id) ?? null;
          setSelf(me);
          setRemoteUsers((res.users ?? []).filter((u) => u.socketId !== socket.id));
          setLeader(res.leader ?? null);
          trace.action('collab:joined', {
            websiteId,
            users: res.users?.length ?? 0,
            leader: res.leader,
          });
        },
      );
    });

    socket.on('connect_error', (err: Error) => {
      // Unauthorized connects throw here — the user isn't signed in,
      // or the cookie expired. We surface the failure quietly; the
      // editor still works without live collab.
      trace.error('collab:connect-error', { message: err.message });
      setIsConnected(false);
    });

    socket.on('disconnect', (reason: string) => {
      trace.action('collab:socket-disconnect', { reason });
      setIsConnected(false);
      setRemoteUsers([]);
      cursorsRef.current.clear();
      selectionsRef.current.clear();
      scheduleFlush();
    });

    socket.on('user-joined', (u: ActiveUser) => {
      trace.action('collab:user-joined', { userId: u.id });
      setRemoteUsers((cur) => (cur.some((x) => x.socketId === u.socketId) ? cur : [...cur, u]));
    });

    socket.on('user-left', ({ socketId, userId }: { socketId: string; userId: string }) => {
      trace.action('collab:user-left', { userId });
      setRemoteUsers((cur) => cur.filter((x) => x.socketId !== socketId));
      cursorsRef.current.delete(userId);
      selectionsRef.current.delete(userId);
      scheduleFlush();
    });

    socket.on('cursor', (payload: RemoteCursor) => {
      cursorsRef.current.set(payload.userId, {
        ...payload,
        // Stamp arrival so the stale-sweep can prune dead cursors.
        _ts: Date.now(),
      } as RemoteCursor & { _ts: number });
      scheduleFlush();
    });

    socket.on('selection', (payload: RemoteSelection) => {
      selectionsRef.current.set(payload.userId, payload);
      scheduleFlush();
    });

    socket.on('color-change', ({ userId, color }: { userId: string; color: string }) => {
      setRemoteUsers((cur) => cur.map((u) => (u.id === userId ? { ...u, color } : u)));
      setSelf((cur) => (cur && cur.id === userId ? { ...cur, color } : cur));
      // Mirror into the persisted-color store so comment avatars (which
      // resolve color by authorId, online or not) recolor live too.
      updateCollaboratorColor(userId, color);
    });

    socket.on('save-leader', ({ leader: l }: { leader: string | null }) => {
      setLeader(l);
    });

    // ─── File-sync (RECV) ──────────────────────────────────────────────────
    // Apply incoming source-code writes from collaborators. Uses the
    // `applyRemoteWrite` / `applyRemoteDelete` paths so projectFS tags
    // the event as `origin: 'remote'` — the broadcast hook below
    // checks that tag and skips re-emitting, avoiding a ping-pong loop.
    socket.on(
      'file-sync',
      ({ userId, path, content }: { userId: string; path: string; content: string }) => {
        trace.action('collab:apply-remote-write', { from: userId, path, size: content.length });
        projectFS.applyRemoteWrite(path, content);
        // Bump the version atom so jotai-derived state (codeAtom, etc.)
        // re-reads from projectFS. Mirrors what `modifyProjectFile`
        // does for local writes.
        bumpVersion((v) => v + 1);
        // 1) Update the mutation-queue's cached `currentCode` if this
        //    write hit the ACTIVE page. Otherwise the next local
        //    mutation would apply against the pre-sync source and
        //    overwrite the remote change on flush — the classic stale-
        //    cache race that caused the canvases to diverge between
        //    viewers (file content WAS getting through; the queue
        //    cache wasn't).
        const activeFile = getDefaultStore().get(activeFilePathAtom);
        if (path === activeFile) {
          syncQueueCode(content);
        }
        // 2) Force the canvas Renderer to repaint. Local writes go
        //    through the mutation queue's flush cycle, which calls
        //    `renderer.markCanvasUpdate()`. Remote writes bypass the
        //    queue entirely, so the iframe DOM stays on the previous
        //    tree unless we explicitly kick it.
        forceCanvasRender();
      },
    );
    socket.on(
      'file-delete',
      ({ userId, path }: { userId: string; path: string }) => {
        trace.action('collab:apply-remote-delete', { from: userId, path });
        projectFS.applyRemoteDelete(path);
        bumpVersion((v) => v + 1);
        const activeFile = getDefaultStore().get(activeFilePathAtom);
        if (path === activeFile) {
          syncQueueCode('');
        }
        forceCanvasRender();
      },
    );

    // ─── File-sync (SEND) ──────────────────────────────────────────────────
    // Every LOCAL projectFS write fires this listener; we debounce per
    // file path at 50ms (matches the old builder's sync cadence) and
    // emit a `file-sync`. Remote-origin writes are dropped at the top
    // so the loop terminates.
    const pendingBroadcasts = new Map<string, ReturnType<typeof setTimeout>>();
    const unsubscribeFs = projectFS.subscribeWrites((e) => {
      if (e.origin === 'remote') return;
      if (!socket.connected) return;
      // Move/snapshot operations skipped in v1 — moves are rare in
      // practice (only file rename, which the canvas surface doesn't
      // expose during live editing) and a full snapshot resync at
      // join time would mask them. Wire later if needed.
      if (e.kind === 'write' && e.path !== undefined && e.content !== undefined) {
        const path = e.path;
        const content = e.content;
        const existing = pendingBroadcasts.get(path);
        if (existing !== undefined) clearTimeout(existing);
        const t = setTimeout(() => {
          pendingBroadcasts.delete(path);
          socket.emit('file-sync', { websiteId, path, content });
          trace.action('collab:broadcast-write', { path, size: content.length });
        }, SYNC_DEBOUNCE_MS);
        pendingBroadcasts.set(path, t);
      } else if (e.kind === 'delete' && e.path !== undefined) {
        const path = e.path;
        const existing = pendingBroadcasts.get(path);
        if (existing !== undefined) clearTimeout(existing);
        // Deletes go out immediately — no value in batching a tombstone.
        socket.emit('file-delete', { websiteId, path });
        trace.action('collab:broadcast-delete', { path });
      }
    });

    // Cleanup on unmount — emit leave then disconnect so the server's
    // presence sweep happens immediately rather than waiting for ping
    // timeout.
    return () => {
      for (const t of pendingBroadcasts.values()) clearTimeout(t);
      pendingBroadcasts.clear();
      unsubscribeFs();
      socket.emit('leave', { websiteId });
      socket.disconnect();
      socketRef.current = null;
      if (pendingFlushRef.current !== null) {
        cancelAnimationFrame(pendingFlushRef.current);
        pendingFlushRef.current = null;
      }
    };
  }, [websiteId, scheduleFlush, bumpVersion]);

  // ─── Senders ───────────────────────────────────────────────────────────

  const sendCursor = useCallback(
    (pos: { x: number; y: number; page?: string } | null) => {
      const socket = socketRef.current;
      if (!socket || !socket.connected || !isConnected) return;
      if (pos === null) {
        // No-op for v1 — leaving the cursor in its last position is
        // visually consistent with how Figma / the reference handle it. A
        // future iteration can emit `cursor-leave` and have receivers
        // fade out.
        return;
      }
      socket.emit('cursor', { websiteId, ...pos });
    },
    [isConnected, websiteId],
  );

  const sendSelection = useCallback(
    (nodeIds: string[], page?: string) => {
      const socket = socketRef.current;
      if (!socket || !socket.connected || !isConnected) return;
      socket.emit('selection', { websiteId, nodeIds, page });
    },
    [isConnected, websiteId],
  );

  const sendColorChange = useCallback(
    (userId: string, color: string) => {
      // Always mirror into the local store first — instant + works even
      // when the socket is down. The backend echoes the event back to
      // the room (incl. the sender), which also calls
      // updateCollaboratorColor — idempotent, so the double-apply is safe.
      updateCollaboratorColor(userId, color);
      const socket = socketRef.current;
      if (!socket || !socket.connected || !isConnected) return;
      socket.emit('color-change', { websiteId, userId, color });
    },
    [isConnected, websiteId],
  );

  const value = useMemo<CollaborationContextValue>(
    () => ({
      isConnected,
      remoteUsers,
      self,
      leader,
      cursors,
      selections,
      sendCursor,
      sendSelection,
      sendColorChange,
    }),
    [isConnected, remoteUsers, self, leader, cursors, selections, sendCursor, sendSelection, sendColorChange],
  );

  return <CollaborationContext.Provider value={value}>{children}</CollaborationContext.Provider>;
}
