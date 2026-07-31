// types.ts — Shared types for the live collaboration layer.
//
// Server protocol mirror: see backend/src/realtime/setup.ts.
// Cursor/selection coordinates use canvas-space (sender converts from
// screen before send so receivers don't need to know the sender's
// pan/zoom). `page` is the active filePath so cursors only render
// when both users are looking at the same page.

interface SocketUser {
  id: string;
  email: string;
  name: string;
  avatar: string | null;
}

export interface ActiveUser extends SocketUser {
  role: 'editor' | 'viewer';
  color: string;
  source: 'owner' | 'workspace' | 'collaborator';
  socketId: string;
}

export interface RemoteCursor {
  userId: string;
  x: number;
  y: number;
  page?: string;
}

export interface RemoteSelection {
  userId: string;
  nodeIds: string[];
  page?: string;
}
