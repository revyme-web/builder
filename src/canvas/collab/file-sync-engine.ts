// file-sync-engine.ts — Ordered, merge-on-receive file sync for live
// collaboration. Pure: the socket, projectFS and the merge are injected
// (CollaborationProvider wires them), so the protocol is testable on its own.
//
// THE BUG IT FIXES. `file-sync` carries a whole file and used to be relayed
// blindly, last-write-wins. Two writes to one file that crossed on the wire
// (two people releasing a drag within ~100ms) left each client holding the
// OTHER's version — the room diverged until someone edited again, and the
// save-leader persisted its own copy (user report 2026-10-19: "the item is at
// one spot for one person and another spot for the other").
//
// THE PROTOCOL (server half: backend/src/realtime/file-seq.ts).
//   • The server numbers every file. Each write carries `baseSeq` — the number
//     of the server version it was built on — and is accepted only if that is
//     still current; the ack returns the new number, or the current one on a
//     refusal.
//   • Per file we keep `base`: the server's content at `seq` as far as we know.
//     Local content !== base means we have edits the room hasn't accepted yet.
//   • A collaborator's write arrives → if we have such edits, 3-way merge them
//     onto it (base / ours / theirs) and send the result on the new number.
//     Socket.IO delivers a socket's packets in order, so a write of ours that
//     the server refuses was refused BECAUSE of a write we've already received
//     and merged — the refusal just means "send again".
//   • One write in flight per file; edits made meanwhile go out after the ack.
//
// A server that predates ordering (no `fileSeqs` in the join ack) gets the old
// fire-and-forget sends, so a frontend deploy never wedges against it.

import { trace } from '@/shared/debug-trace';

export interface FileSyncAck { ok: boolean; seq?: number }

export interface FileSyncDeps {
  /** Emit a write. `baseSeq` is omitted for a legacy server; `ack` may then
   *  never be called. */
  send(path: string, content: string, baseSeq: number | undefined, ack: (res: FileSyncAck) => void): void;
  /** Current local content (null = absent). */
  read(path: string): string | null;
  /** Write locally WITHOUT rebroadcasting (remote origin) + repaint. */
  apply(path: string, content: string): void;
  /** Delete locally without rebroadcasting. */
  applyDelete(path: string): void;
  /** 3-way merge of our unsent edits onto a collaborator's write. */
  merge(path: string, base: string | null, ours: string, theirs: string): string;
  /** True while this client is mid-way through producing a local write (the
   *  mutation queue between computing and writing a flush): a remote write
   *  applied then would be overwritten by that flush, so it waits. */
  isBusy(): boolean;
  debounceMs?: number;
}

interface PathState {
  seq: number;
  base: string | null;
  inflight: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

type RemoteOp =
  | { kind: 'write'; path: string; content: string; seq?: number }
  | { kind: 'delete'; path: string; seq?: number };

/** Remote writes wait at most this long for a busy queue, then apply anyway —
 *  a wedged flag must never stop the room's edits from landing. */
const MAX_BUSY_WAIT_MS = 500;
const BUSY_RETRY_MS = 16;

export class FileSyncEngine {
  private joined = false;
  private ordered = false;
  private states = new Map<string, PathState>();
  private remoteQueue: RemoteOp[] = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private busySince: number | null = null;

  constructor(private deps: FileSyncDeps) {}

  /** Joined (or re-joined) the room. Our copy of every file is taken as the
   *  server's current version of it; `seqs` null = legacy server. */
  join(files: Map<string, string>, seqs: Record<string, number> | null): void {
    this.reset();
    this.ordered = seqs !== null;
    for (const [path, content] of files) {
      this.states.set(path, { seq: seqs?.[path] ?? 0, base: content, inflight: false, timer: null });
    }
    for (const [path, seq] of Object.entries(seqs ?? {})) {
      if (!this.states.has(path)) this.states.set(path, { seq, base: null, inflight: false, timer: null });
    }
    this.joined = true;
    trace.action('collab:sync-joined', { files: files.size, ordered: this.ordered });
  }

  /** Disconnected: pending sends and acks are void; `join` starts over. */
  leave(): void {
    this.reset();
    this.joined = false;
  }

  /** The local project was replaced wholesale (import / rollback). Snapshot
   *  loads have never been broadcast; re-base so they aren't later mistaken
   *  for unsent edits and merged into collaborators' writes. */
  rebaseAll(files: Map<string, string>): void {
    if (!this.joined) return;
    for (const [path, content] of files) {
      const st = this.state(path);
      st.base = content;
    }
  }

  onLocalWrite(path: string): void {
    if (!this.joined) return;
    this.schedule(path);
  }

  /** A local delete went out immediately (tombstones aren't batched). */
  onLocalDelete(path: string): void {
    const st = this.states.get(path);
    if (st?.timer) clearTimeout(st.timer);
    this.states.delete(path);
  }

  onRemoteWrite(path: string, content: string, seq?: number): void {
    this.remoteQueue.push({ kind: 'write', path, content, seq });
    this.drain();
  }

  onRemoteDelete(path: string, seq?: number): void {
    this.remoteQueue.push({ kind: 'delete', path, seq });
    this.drain();
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private reset(): void {
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = null;
    this.busySince = null;
    // Remote ops already received still apply, in order and against the
    // CURRENT bases — they are the room's state whatever happens next.
    const pending = this.remoteQueue;
    this.remoteQueue = [];
    for (const op of pending) this.applyRemote(op);
    for (const st of this.states.values()) if (st.timer) clearTimeout(st.timer);
    this.states.clear();
  }

  private state(path: string): PathState {
    let st = this.states.get(path);
    if (!st) {
      // First sight of a file created after join: absent on the server too.
      st = { seq: 0, base: null, inflight: false, timer: null };
      this.states.set(path, st);
    }
    return st;
  }

  private drain(): void {
    if (this.drainTimer) return;
    while (this.remoteQueue.length > 0) {
      if (this.deps.isBusy()) {
        const now = Date.now();
        this.busySince ??= now;
        if (now - this.busySince < MAX_BUSY_WAIT_MS) {
          this.drainTimer = setTimeout(() => { this.drainTimer = null; this.drain(); }, BUSY_RETRY_MS);
          return;
        }
        trace.error('collab:sync-busy-timeout', { waitedMs: now - this.busySince });
      }
      this.busySince = null;
      this.applyRemote(this.remoteQueue.shift()!);
    }
  }

  private applyRemote(op: RemoteOp): void {
    const st = this.joined ? this.state(op.path) : null;
    if (op.kind === 'delete') {
      if (st) {
        if (st.timer) clearTimeout(st.timer);
        st.timer = null;
        st.base = null;
        if (op.seq !== undefined) st.seq = op.seq;
      }
      this.deps.applyDelete(op.path);
      return;
    }
    const { path, content, seq } = op;
    const local = this.deps.read(path);
    if (!st) {
      // Join ack still pending: plain apply; `join` snapshots the result.
      if (local !== content) this.deps.apply(path, content);
      return;
    }
    let next = content;
    if (local !== null && local !== st.base && local !== content) {
      next = this.deps.merge(path, st.base, local, content);
      trace.action('collab:sync-rebased', { path, seq, keptLocalEdits: next !== content });
    }
    st.base = content;
    if (seq !== undefined) st.seq = seq;
    if (next !== local) this.deps.apply(path, next);
    if (next !== content) this.schedule(path);
  }

  private schedule(path: string): void {
    const st = this.state(path);
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(() => {
      st.timer = null;
      this.flush(path, st);
    }, this.deps.debounceMs ?? 50);
  }

  private flush(path: string, st: PathState): void {
    if (!this.joined || this.states.get(path) !== st || st.inflight) return;
    const content = this.deps.read(path);
    if (content === null || content === st.base) return;
    if (!this.ordered) {
      this.deps.send(path, content, undefined, () => {});
      st.base = content;
      return;
    }
    st.inflight = true;
    this.deps.send(path, content, st.seq, (res) => {
      // Left / re-joined meanwhile: this ack belongs to a dead numbering.
      if (this.states.get(path) !== st) return;
      st.inflight = false;
      if (res.ok && typeof res.seq === 'number') {
        st.seq = res.seq;
        st.base = content;
      } else if (typeof res.seq === 'number' && res.seq > st.seq) {
        // Refused by a write we never received — can't happen while the
        // socket preserves order, but never wedge on it: adopt the number,
        // and the resend below lands our file.
        trace.error('collab:sync-refused-unseen', { path, ours: st.seq, server: res.seq });
        st.seq = res.seq;
      }
      if (this.deps.read(path) !== st.base) this.schedule(path);
    });
  }
}
