import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FileSyncEngine, type FileSyncAck } from './file-sync-engine';
import { rebaseLocalEdits } from './collab-merge';

// Two editors and an ordering server (the backend's file-seq rules) on an
// explicit network: nothing is delivered until `net.pump()`, so a test can
// make two writes CROSS — the exact race that left the room showing one
// element in two places (user report 2026-10-19).

const PATH = 'app/page.tsx';
const page = (blue: string, pink: string) => `export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative' }}>
      <div data-id="blue" style={{ position: 'absolute', left: '${blue}' }} />
      <div data-id="pink" style={{ position: 'absolute', left: '${pink}' }} />
    </div>
  );
}
`;

type Packet = () => void;

class Net {
  private queue: Packet[] = [];
  post(p: Packet) { this.queue.push(p); }
  /** Deliver everything, including packets produced while delivering. */
  pump() {
    for (let guard = 0; this.queue.length > 0 && guard < 1000; guard++) {
      this.queue.shift()!();
      vi.advanceTimersByTime(60); // debounce + busy retries
    }
  }
}

class Server {
  seq = new Map<string, number>();
  clients: Client[] = [];
  /** null = a pre-ordering server: blind relay, no acks. */
  constructor(private net: Net, public ordered = true) {}
  receive(from: Client, path: string, content: string, baseSeq: number | undefined, ack: (r: FileSyncAck) => void) {
    const cur = this.seq.get(path) ?? 0;
    if (this.ordered && baseSeq !== undefined && baseSeq !== cur) {
      this.net.post(() => ack({ ok: false, seq: cur }));
      return;
    }
    const next = cur + 1;
    this.seq.set(path, next);
    for (const c of this.clients) {
      if (c !== from) this.net.post(() => c.engine.onRemoteWrite(path, content, this.ordered ? next : undefined));
    }
    if (this.ordered) this.net.post(() => ack({ ok: true, seq: next }));
  }
}

class Client {
  files = new Map<string, string>();
  busy = false;
  sent = 0;
  engine: FileSyncEngine;
  constructor(net: Net, server: Server, initial: string) {
    this.files.set(PATH, initial);
    this.engine = new FileSyncEngine({
      send: (path, content, baseSeq, ack) => {
        this.sent++;
        net.post(() => server.receive(this, path, content, baseSeq, ack));
      },
      read: (path) => this.files.get(path) ?? null,
      apply: (path, content) => { this.files.set(path, content); },
      applyDelete: (path) => { this.files.delete(path); },
      merge: rebaseLocalEdits,
      isBusy: () => this.busy,
    });
    server.clients.push(this);
    this.engine.join(new Map(this.files), server.ordered ? Object.fromEntries(server.seq) : null);
  }
  edit(content: string) {
    this.files.set(PATH, content);
    this.engine.onLocalWrite(PATH);
    vi.advanceTimersByTime(60); // past the 50ms debounce → the send is posted
  }
  get code() { return this.files.get(PATH); }
}

describe('FileSyncEngine — ordered sync converges', () => {
  let net: Net;
  let server: Server;
  beforeEach(() => { vi.useFakeTimers(); net = new Net(); server = new Server(net); });
  afterEach(() => { vi.useRealTimers(); });

  it('two people dragging the SAME element → both end up on one position', () => {
    const a = new Client(net, server, page('0px', '200px'));
    const b = new Client(net, server, page('0px', '200px'));
    a.edit(page('100px', '200px'));   // A drops blue at 100
    b.edit(page('300px', '200px'));   // B drops blue at 300 — the writes cross
    net.pump();
    expect(a.code).toBe(b.code);
    // A's write won the server; B rebased its own edit on top and resent, so
    // the later committer's position is the one everyone sees.
    expect(a.code).toBe(page('300px', '200px'));
  });

  it('crossing edits to DIFFERENT elements keep both', () => {
    const a = new Client(net, server, page('0px', '200px'));
    const b = new Client(net, server, page('0px', '200px'));
    a.edit(page('100px', '200px'));   // A moves blue
    b.edit(page('0px', '500px'));     // B moves pink
    net.pump();
    expect(a.code).toBe(page('100px', '500px'));
    expect(b.code).toBe(a.code);
  });

  it('a write with no local edits pending is applied as-is', () => {
    const a = new Client(net, server, page('0px', '200px'));
    const b = new Client(net, server, page('0px', '200px'));
    a.edit(page('100px', '200px'));
    net.pump();
    expect(b.code).toBe(page('100px', '200px'));
    expect(b.sent).toBe(0); // nothing echoed back
  });

  it('edits made while a write is in flight follow after its ack, on the new number', () => {
    const a = new Client(net, server, page('0px', '200px'));
    const b = new Client(net, server, page('0px', '200px'));
    a.edit(page('100px', '200px'));
    a.edit(page('150px', '200px'));   // in flight: held back
    expect(a.sent).toBe(1);
    net.pump();
    expect(a.sent).toBe(2);
    expect(b.code).toBe(page('150px', '200px'));
    expect(server.seq.get(PATH)).toBe(2);
  });

  it('three-way crossing still converges', () => {
    const a = new Client(net, server, page('0px', '200px'));
    const b = new Client(net, server, page('0px', '200px'));
    const c = new Client(net, server, page('0px', '200px'));
    a.edit(page('100px', '200px'));
    b.edit(page('300px', '200px'));
    c.edit(page('0px', '700px'));
    net.pump();
    expect(b.code).toBe(a.code);
    expect(c.code).toBe(a.code);
    expect(a.code).toContain("left: '700px'"); // C's pink edit survived
  });

  it('a remote write waits while the local queue is mid-flush, then merges', () => {
    const a = new Client(net, server, page('0px', '200px'));
    const b = new Client(net, server, page('0px', '200px'));
    b.busy = true;
    a.edit(page('100px', '200px'));
    net.pump();
    expect(b.code).toBe(page('0px', '200px')); // held back
    // The flush lands (a local pink move), THEN the queue frees up.
    b.files.set(PATH, page('0px', '500px'));
    b.engine.onLocalWrite(PATH);
    b.busy = false;
    vi.advanceTimersByTime(100); // busy retry applies + merges, then the resend debounce fires
    net.pump();
    expect(b.code).toBe(page('100px', '500px'));
    expect(a.code).toBe(b.code);
  });

  it('(the bug) the old blind relay leaves the room split on the same race', () => {
    server = new Server(net, false);
    const a = new Client(net, server, page('0px', '200px'));
    const b = new Client(net, server, page('0px', '200px'));
    a.edit(page('100px', '200px'));
    b.edit(page('300px', '200px'));
    net.pump();
    // Each holds the OTHER's version — what the tester saw.
    expect(a.code).toBe(page('300px', '200px'));
    expect(b.code).toBe(page('100px', '200px'));
  });

  it('a legacy server (no fileSeqs) gets the old fire-and-forget sends', () => {
    server = new Server(net, false);
    const a = new Client(net, server, page('0px', '200px'));
    const b = new Client(net, server, page('0px', '200px'));
    a.edit(page('100px', '200px'));
    a.edit(page('150px', '200px'));   // no ack to wait for
    expect(a.sent).toBe(2);
    net.pump();
    expect(b.code).toBe(page('150px', '200px'));
  });

  it('after leave, a late ack is ignored and nothing more is sent', () => {
    const a = new Client(net, server, page('0px', '200px'));
    a.edit(page('100px', '200px'));
    a.engine.leave();
    net.pump();
    a.files.set(PATH, page('120px', '200px'));
    a.engine.onLocalWrite(PATH);
    vi.advanceTimersByTime(100);
    expect(a.sent).toBe(1);
  });
});
