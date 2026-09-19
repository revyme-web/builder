// src/ai/agent/tools/observation-epoch.test.ts
//
// P6 (T4) proofs: an observation is `ready` ONLY at 100 % coverage on a
// fresh epoch. Partial or stale snapshots are `pending` with an honest
// reason (UNMEASURED ids / stale versions) — never `ready`, never a clean
// pass on unmeasured nodes.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDefaultStore } from 'jotai';
import type { CanvasNode } from '@/code/parsing/parser';
import {
  resetActiveBridge,
  setActiveBridge,
  type CacheEpoch,
  type CanvasBridge,
} from '@/canvas/canvas-bridge';
import { projectVersionAtom } from '@/code/project/project-fs';
import {
  UNMEASURED_CAP,
  collectEpochSnapshot,
  formatEpochEnvelope,
  formatUnmeasured,
  observationStatusWithEpoch,
} from './observation-epoch';

function makeNode(id: string): CanvasNode {
  return {
    id,
    type: 'div',
    name: id,
    parentId: null,
    children: [],
    styles: {},
    textContent: '',
    attrs: {},
    hasMixedContent: false,
    order: 0,
    isCanvasNode: true,
    componentFile: null,
    componentInstanceId: null,
    isComponentRoot: false,
    motionVariants: null,
    motionVariantsRef: null,
    motionProps: null,
    responsiveVariantMap: null,
    conditionalStyles: null,
  };
}

/** Minimal bridge: serves rects by id, with a controllable fill epoch. */
class EpochBridge implements CanvasBridge {
  rects = new Map<string, { left: number; top: number; width: number; height: number }>();
  /** Fill epoch served — null = bridge exposes no epoch (old stub). */
  epoch: CacheEpoch | 'absent' = { renderSeq: 7, projectVersion: 0 };

  getCacheEpoch(): CacheEpoch | null {
    return this.epoch === 'absent' ? null : this.epoch;
  }
  getRect(nodeId: string): DOMRect | null {
    const r = this.rects.get(nodeId);
    return r
      ? ({ left: r.left, top: r.top, width: r.width, height: r.height, x: r.left, y: r.top } as DOMRect)
      : null;
  }
  getChildRects(): Array<{ id: string; rect: DOMRect }> {
    return [];
  }
  getComputedValue(): string {
    return '';
  }
  getComputedValues(nodeId: string, vpPrefix: string, props: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of props) out[p] = '';
    return out;
  }
  getCachedComputedStyles(nodeId: string, vpPrefix: string, props: string[]): Record<string, string> {
    return this.getComputedValues(nodeId, vpPrefix, props);
  }
  getContainerRect(): DOMRect | null {
    return null;
  }
  getElementIdsAtPoint(): string[] {
    return [];
  }
  patchStyles(): void {}
  patchAttrsAndStyles(): void {}
  setInnerHTML(): void {}
  setAttribute(): void {}
  injectCSS(): void {}
  removeCSS(): void {}
  getIframeDocument(): Document | null {
    return null;
  }
  loadFontInIframe(): void {}
}

const store = getDefaultStore();
let bridge: EpochBridge;
let savedVersion: number;

const NODES = new Map<string, CanvasNode>([
  ['a', makeNode('a')],
  ['b', makeNode('b')],
]);

const RECT = { left: 0, top: 0, width: 100, height: 50 };

beforeEach(() => {
  savedVersion = store.get(projectVersionAtom);
  store.set(projectVersionAtom, 42);
  bridge = new EpochBridge();
  bridge.epoch = { renderSeq: 7, projectVersion: 42 };
  setActiveBridge(bridge);
});

afterEach(() => {
  resetActiveBridge();
  store.set(projectVersionAtom, savedVersion);
});

describe('collectEpochSnapshot', () => {
  it('stamps full coverage + a fresh epoch', () => {
    bridge.rects.set('a', RECT);
    bridge.rects.set('b', RECT);
    const { epoch } = collectEpochSnapshot(NODES, 'desktop');
    expect(epoch.withRect).toBe(2);
    expect(epoch.total).toBe(2);
    expect(epoch.stale).toBe(false);
    expect(epoch.renderSeq).toBe(7);
    expect(epoch.projectVersionAtFill).toBe(42);
    expect(epoch.projectVersionNow).toBe(42);
    expect(epoch.unmeasured).toEqual([]);
    expect(epoch.unmeasuredTotal).toBe(0);
  });

  it('lists unmeasured ids on a partial snapshot', () => {
    bridge.rects.set('a', RECT);
    const { epoch } = collectEpochSnapshot(NODES, 'desktop');
    expect(epoch.withRect).toBe(1);
    expect(epoch.total).toBe(2);
    expect(epoch.unmeasured).toEqual(['b']);
    expect(epoch.unmeasuredTotal).toBe(1);
  });

  it('marks stale when the project moved since the fill', () => {
    bridge.rects.set('a', RECT);
    bridge.rects.set('b', RECT);
    bridge.epoch = { renderSeq: 7, projectVersion: 41 };
    const { epoch } = collectEpochSnapshot(NODES, 'desktop');
    expect(epoch.stale).toBe(true);
    expect(epoch.projectVersionAtFill).toBe(41);
    expect(epoch.projectVersionNow).toBe(42);
  });

  it('marks stale when the bridge exposes no epoch (unprovable freshness)', () => {
    bridge.rects.set('a', RECT);
    bridge.rects.set('b', RECT);
    bridge.epoch = 'absent';
    const { epoch } = collectEpochSnapshot(NODES, 'desktop');
    expect(epoch.stale).toBe(true);
    expect(epoch.renderSeq).toBeNull();
  });

  it('is not stale when nothing was measured (pending covers it)', () => {
    const { epoch } = collectEpochSnapshot(NODES, 'desktop');
    expect(epoch.withRect).toBe(0);
    expect(epoch.stale).toBe(false);
  });

  it('caps the unmeasured list but keeps the full count', () => {
    const many = new Map<string, CanvasNode>();
    for (let i = 0; i < UNMEASURED_CAP + 5; i++) many.set(`n${i}`, makeNode(`n${i}`));
    const { epoch } = collectEpochSnapshot(many, 'desktop');
    expect(epoch.unmeasured).toHaveLength(UNMEASURED_CAP);
    expect(epoch.unmeasuredTotal).toBe(UNMEASURED_CAP + 5);
    expect(formatUnmeasured(epoch)).toContain('UNMEASURED: [');
    expect(formatUnmeasured(epoch)).toContain('+5 more');
  });
});

describe('observationStatusWithEpoch', () => {
  it('is ready only at full coverage on a fresh epoch', () => {
    bridge.rects.set('a', RECT);
    bridge.rects.set('b', RECT);
    const { epoch } = collectEpochSnapshot(NODES, 'desktop');
    const obs = observationStatusWithEpoch({ id: 'desktop', width: 1440 }, epoch);
    expect(obs.status).toBe('ready');
  });

  it('is pending (not ready) on a partial snapshot, naming UNMEASURED', () => {
    bridge.rects.set('a', RECT);
    const { epoch } = collectEpochSnapshot(NODES, 'desktop');
    const obs = observationStatusWithEpoch({ id: 'desktop', width: 1440 }, epoch);
    expect(obs.status).toBe('pending');
    expect(obs.reason).toContain('Not measured: 1/2');
    expect(obs.reason).toContain('UNMEASURED: [b]');
  });

  it('is pending (not ready) on a stale snapshot, naming the versions', () => {
    bridge.rects.set('a', RECT);
    bridge.rects.set('b', RECT);
    bridge.epoch = { renderSeq: 7, projectVersion: 41 };
    const { epoch } = collectEpochSnapshot(NODES, 'desktop');
    const obs = observationStatusWithEpoch({ id: 'desktop', width: 1440 }, epoch);
    expect(obs.status).toBe('pending');
    expect(obs.reason).toContain('Stale');
    expect(obs.reason).toContain('41');
    expect(obs.reason).toContain('42');
  });

  it('is pending when nothing is cached yet', () => {
    const { epoch } = collectEpochSnapshot(NODES, 'desktop');
    const obs = observationStatusWithEpoch({ id: 'desktop', width: 1440 }, epoch);
    expect(obs.status).toBe('pending');
  });

  it('is unavailable for an unknown viewport', () => {
    bridge.rects.set('a', RECT);
    bridge.rects.set('b', RECT);
    const { epoch } = collectEpochSnapshot(NODES, 'nope');
    const obs = observationStatusWithEpoch({ id: 'nope', width: null }, epoch);
    expect(obs.status).toBe('unavailable');
  });
});

describe('formatEpochEnvelope', () => {
  it('carries {epoch, coverage, unmeasured} on every observation', () => {
    bridge.rects.set('a', RECT);
    const { epoch } = collectEpochSnapshot(NODES, 'desktop');
    const env = formatEpochEnvelope(epoch);
    expect(env.epoch).toEqual({ renderSeq: 7, projectVersionAtFill: 42, projectVersionNow: 42, stale: false });
    expect(env.coverage).toEqual({ withRect: 1, total: 2 });
    expect(env.unmeasured).toEqual(['b']);
    expect(env.unmeasuredTotal).toBe(1);
  });
});
