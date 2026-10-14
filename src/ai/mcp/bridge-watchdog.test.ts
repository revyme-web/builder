// bridge-watchdog.test.ts — a tab must not drop off the MCP bridge for good.
//
// EventSource stays CLOSED forever once a reconnect gets a non-200 (or the
// page was frozen when it should have retried): an agent's headless tab lost
// the bridge six times in one day and only came back when reloaded
// (2026-10-14). The watchdog reopens a closed source with backoff, and
// replaces one that went silent after it had been sending pings.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, () => void>();
  closed = false;
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  addEventListener(type: string, fn: () => void) { this.listeners.set(type, fn); }
  close() { this.closed = true; this.readyState = FakeEventSource.CLOSED; }
  open() { this.readyState = FakeEventSource.OPEN; this.onopen?.(); }
  ping() { this.listeners.get('ping')?.(); }
}

vi.stubGlobal('EventSource', FakeEventSource);

const { startMcpBridge, stopMcpBridge, checkMcpBridgeHealth } = await import('./bridge-client');

const latest = () => FakeEventSource.instances[FakeEventSource.instances.length - 1];

beforeEach(() => {
  FakeEventSource.instances = [];
  startMcpBridge();
});
afterEach(() => stopMcpBridge());

describe('MCP bridge watchdog', () => {
  it('reopens a source the browser gave up on', () => {
    const first = latest();
    first.open();
    first.readyState = FakeEventSource.CLOSED; // e.g. a 502 on its reconnect
    checkMcpBridgeHealth('test', Date.now());
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(latest()).not.toBe(first);
  });

  it('backs off while reconnects keep failing', () => {
    const t0 = Date.now();
    latest().readyState = FakeEventSource.CLOSED;
    checkMcpBridgeHealth('test', t0);               // attempt 1 (now)
    latest().readyState = FakeEventSource.CLOSED;
    checkMcpBridgeHealth('test', t0 + 1_000);       // inside the 5s backoff → wait
    expect(FakeEventSource.instances).toHaveLength(2);
    checkMcpBridgeHealth('test', t0 + 6_000);       // backoff elapsed → attempt 2
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it('replaces an open source that went silent after it had been pinging', () => {
    const first = latest();
    first.open();
    first.ping();
    checkMcpBridgeHealth('test', Date.now() + 80_000);
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('does not trust silence from a service that never sent a named ping (older service)', () => {
    const first = latest();
    first.open();
    checkMcpBridgeHealth('test', Date.now() + 10 * 60_000);
    expect(first.closed).toBe(false);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('a healthy source is left alone', () => {
    const first = latest();
    first.open();
    first.ping();
    checkMcpBridgeHealth('test', Date.now() + 10_000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
