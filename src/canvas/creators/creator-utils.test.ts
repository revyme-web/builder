import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { findParentAtPoint, nextFrameColor } from './creator-utils';
import { generateNodeId } from '@/shared/id-utils';
import { setActiveBridge } from '@/canvas/canvas-bridge';
import type { CanvasBridge } from '@/canvas/canvas-bridge';
import type { CanvasNode } from '@/code/parsing/parser';

describe('generateNodeId', () => {
  it('generates unique IDs', () => {
    const a = generateNodeId();
    const b = generateNodeId();
    expect(a).not.toBe(b);
  });

  it('uses default frame prefix', () => {
    expect(generateNodeId()).toMatch(/^frame-/);
  });

  it('uses custom prefix', () => {
    expect(generateNodeId('text')).toMatch(/^text-/);
  });
});

describe('nextFrameColor', () => {
  it('returns a hex color', () => {
    expect(nextFrameColor()).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('cycles through colors', () => {
    const colors = new Set<string>();
    for (let i = 0; i < 20; i++) colors.add(nextFrameColor());
    expect(colors.size).toBe(10); // 10 unique colors in palette
  });
});

// ─── findParentAtPoint — drop target detection ─────────────────────────────

/**
 * Build a fake bridge with a populated rect cache. Mirrors the entries the
 * sandbox emits on every render (per `bridge-host.ts:allRects`). Only the
 * fields exercised by `findParentAtPoint` / `findRootHitAtPoint` are wired —
 * unused methods throw so accidental dependence on them is caught loudly.
 */
function makeFakeBridge(rects: Array<{ key: string; rect: DOMRect }>): CanvasBridge {
  const cache = new Map<string, DOMRect>();
  for (const { key, rect } of rects) cache.set(key, rect);
  const bridge: any = {
    rectCache: cache,
    getRect(nodeId: string, vpPrefix: string) {
      return cache.get(`${vpPrefix}:${nodeId}`) ?? null;
    },
    getChildRects: () => [],
    getComputedValue: () => '',
    getComputedValues: () => ({}),
    getContainerRect: () => null,
    getElementIdsAtPoint: () => [],
    patchStyles: () => {},
    injectCSS: () => {},
    removeCSS: () => {},
  };
  return bridge as CanvasBridge;
}

describe('findParentAtPoint — drop-target safety vs layout-merged nodes', () => {
  let originalBridge: CanvasBridge;

  beforeEach(() => {
    // Capture so we can restore — module-level singleton bleeds across tests
    originalBridge = (globalThis as any).__bridgeBackup ?? null;
  });

  afterEach(() => {
    // Reset to a no-op bridge so unrelated tests aren't polluted
    setActiveBridge(makeFakeBridge([]));
  });

  it('falls back to the page root when only layout::layout-root encloses the point', () => {
    // Simulates a normal page where root has no children — the only frames
    // in the iframe DOM are layout::layout-root (whole viewport, includes
    // navbar+footer) and root (the page slot, smaller). Without the fix the
    // hit-test returned layout::layout-root and the addNode mutation went
    // to the wrong file.
    setActiveBridge(makeFakeBridge([
      { key: ':layout::layout-root', rect: new DOMRect(0, 0, 1440, 900) },
      { key: ':root', rect: new DOMRect(0, 80, 1440, 700) },
    ]));
    const nodes: Map<string, CanvasNode> = new Map([
      // layout-root tagged via layout:: prefix — must be skipped
      ['layout::layout-root', { id: 'layout::layout-root', type: 'div', styles: {}, children: [] } as any],
      ['root', { id: 'root', type: 'div', styles: {}, children: [] } as any],
    ]);
    const parent = findParentAtPoint(500, 400, nodes);
    expect(parent).not.toBeNull();
    expect(parent!.nodeId).toBe('root');
  });

  it('returns null when point is outside any viewport (canvas-level drop)', () => {
    setActiveBridge(makeFakeBridge([
      { key: ':root', rect: new DOMRect(0, 0, 1440, 900) },
    ]));
    const nodes = new Map<string, CanvasNode>([
      ['root', { id: 'root', type: 'div', styles: {}, children: [] } as any],
    ]);
    // Point well outside the root rect
    expect(findParentAtPoint(2000, 2000, nodes)).toBeNull();
  });

  it('prefers a deeper non-layout frame over the root fallback', () => {
    // Card is smaller (deeper) than root. Drop should land in Card.
    setActiveBridge(makeFakeBridge([
      { key: ':root', rect: new DOMRect(0, 0, 1440, 900) },
      { key: ':card', rect: new DOMRect(100, 100, 300, 200) },
    ]));
    const nodes = new Map<string, CanvasNode>([
      ['root', { id: 'root', type: 'div', styles: {}, children: ['card'] } as any],
      ['card', { id: 'card', type: 'div', styles: {}, children: [] } as any],
    ]);
    const parent = findParentAtPoint(150, 150, nodes);
    expect(parent!.nodeId).toBe('card');
  });

  it('skips a component INSTANCE (drop lands in its parent, not inside the instance)', () => {
    // A component instance frame sits inside the page root. Drawing over it must NOT nest into
    // the instance (its children come from the external component file) — it lands in `root`.
    setActiveBridge(makeFakeBridge([
      { key: ':inst', rect: new DOMRect(100, 100, 300, 600) },
      { key: ':root', rect: new DOMRect(0, 0, 1440, 900) },
    ]));
    const nodes = new Map<string, CanvasNode>([
      ['root', { id: 'root', type: 'div', styles: {}, children: ['inst'] } as any],
      ['inst', { id: 'inst', type: 'ViTiPa', styles: {}, children: [], isComponentInstance: true } as any],
    ]);
    const parent = findParentAtPoint(200, 300, nodes);
    expect(parent!.nodeId).toBe('root');   // NOT 'inst'
  });

  it('skips a component instance INTERNAL (componentInstanceId) → parent of the instance', () => {
    // Drawing over a box rendered INSIDE the instance (an expanded internal) must also fall
    // through — internals belong to the master's file, not this page.
    setActiveBridge(makeFakeBridge([
      { key: ':inner', rect: new DOMRect(150, 200, 100, 80) },   // smallest → deepest hit
      { key: ':inst', rect: new DOMRect(100, 100, 300, 600) },
      { key: ':frame', rect: new DOMRect(50, 50, 500, 800) },
      { key: ':root', rect: new DOMRect(0, 0, 1440, 900) },
    ]));
    const nodes = new Map<string, CanvasNode>([
      ['root', { id: 'root', type: 'div', styles: {}, children: ['frame'] } as any],
      ['frame', { id: 'frame', type: 'div', styles: {}, children: ['inst'] } as any],
      ['inst', { id: 'inst', type: 'ViTiPa', styles: {}, children: [], isComponentInstance: true } as any],
      ['inner', { id: 'inner', type: 'div', styles: {}, children: [], componentInstanceId: 'inst' } as any],
    ]);
    const parent = findParentAtPoint(180, 240, nodes);
    expect(parent!.nodeId).toBe('frame');   // skips inner + inst, lands on the real parent frame
  });

  it('skips children-slot placeholder and falls back to root', () => {
    setActiveBridge(makeFakeBridge([
      { key: ':children-slot', rect: new DOMRect(0, 80, 1440, 700) },
      { key: ':root', rect: new DOMRect(0, 80, 1440, 700) },
    ]));
    const nodes = new Map<string, CanvasNode>([
      ['children-slot', { id: 'children-slot', type: 'div', styles: {}, children: [] } as any],
      ['root', { id: 'root', type: 'div', styles: {}, children: [] } as any],
    ]);
    const parent = findParentAtPoint(500, 400, nodes);
    expect(parent!.nodeId).toBe('root');
  });
});

// ─── buildDuplicateDescriptor — id map + ::after border carry ───────────────

describe('buildDuplicateDescriptor id map + queueBorderOverlayDuplicates', () => {
  it('fills idMap for the whole subtree with fresh ids', async () => {
    const { buildDuplicateDescriptor } = await import('./creator-utils');
    const nodes = new Map<string, any>([
      ['wrap-1', { type: 'div', name: 'Wrap', styles: {}, children: ['ring-1'] }],
      ['ring-1', { type: 'div', name: 'Ring', styles: {}, children: [] }],
    ]);
    const idMap = new Map<string, string>();
    const desc = buildDuplicateDescriptor('wrap-1', nodes, idMap)!;
    expect(idMap.size).toBe(2);
    expect(idMap.get('wrap-1')).toBe(desc.id);
    expect(idMap.get('ring-1')).toBe(desc.children![0].id);
    expect(idMap.get('ring-1')).not.toBe('ring-1');
  });

  it('queues an updateBorderOverlay copy for mapped ids that have an ::after rule', async () => {
    // Alt-drag duplicate flavor: rules live in the CURRENT file's <style>
    // block; the clone (fresh id) must get its own rule or the border is
    // silently lost on the duplicate (user report 2026-07-29).
    const { queueBorderOverlayDuplicates } = await import('./creator-utils');
    const { initMutationQueue, flushNow, setActiveFilePath } = await import('@/code/mutation/mutation-queue');
    const { setBumpVersion } = await import('@/code/project/modify-file');
    const { extractStyleCSS } = await import('@/code/parsing/parser');
    const { extractBorderAfterRuleBody } = await import('@/editor/ui/border-utils');

    const code = `'use client';
import React from 'react';
export default function Page() {
  return <div data-id="root" style={{ position: 'relative' }}>
  <style>{\`
    [data-id="ring-1"]::after {
  content: '';
  border-width: 4px;
  border-style: dashed;
    }
  \`}</style>
    <div data-id="ring-1" data-name="Ring" style={{ width: '65px' }}></div>
  </div>;
}`;
    let written = code;
    setActiveFilePath('app/page.tsx');
    setBumpVersion(() => {});
    initMutationQueue(code, c => { written = c; });

    queueBorderOverlayDuplicates(new Map([
      ['ring-1', 'dup-ring-9'],
      ['plain-2', 'dup-plain-9'], // no rule → nothing queued for it
    ]));
    flushNow();

    const css = extractStyleCSS(written);
    const dupBody = extractBorderAfterRuleBody(css, 'dup-ring-9');
    expect(dupBody).toContain('border-width: 4px');
    expect(dupBody).toContain('border-style: dashed');
    expect(extractBorderAfterRuleBody(css, 'ring-1')).toContain('border-width: 4px');
    expect(extractBorderAfterRuleBody(css, 'dup-plain-9')).toBeNull();
  });
});
