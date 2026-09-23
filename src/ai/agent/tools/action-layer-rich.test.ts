// src/ai/agent/tools/action-layer-rich.test.ts
//
// Rich action-layer primitives (N1): set_motion_preset / create_overlay /
// set_variant / bind_cms_list / bind_cms_field / set_form / create_page.
// Zero LLM, zero BENCH_RUN.
//
// PARITY — every mutation payload below is asserted byte-for-byte against the
// write the corresponding panel emits (AnimationTool handleAdd seeds,
// OverlayTool handleCreate, ControlProvider variant writes, the CMS drop and
// BindButton, FormStateTool). The tests may import src/editor (the module
// itself never does — the action-layer precedent); the appear reveal is
// cross-checked against the REAL appear-utils. Scope expectations are computed
// with the SAME resolveScope the panel uses, and the loop/hover/cms payloads
// are additionally driven through the REAL generators on page fixtures.
//
// ANTI-PERMISSIVITY — values the panels cannot express (unknown presets,
// 'custom' ease, overlay trigger 'event' without an event name, modes outside
// the panel enums) are rejected at schema level; unmapping via '' is honored.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import type { Mutation } from '@/code/mutation/mutation-queue';
import { queueMutation, flushNow, getCurrentCode } from '@/code/mutation/mutation-queue';

type CreateOverlayMutation = Extract<Mutation, { type: 'createOverlay' }>;
import type { AgentTool, ToolContext } from '@/ai/agent';
import {
  setMotionPresetTool,
  createOverlayTool,
  setVariantTool,
  createVariantTool,
  extractComponentTool,
  bindCmsListTool,
  bindCmsFieldTool,
  setFormTool,
  createPageTool,
  createComponentTool,
  RICH_ACTION_TOOLS,
  MOTION_PRESET_VALUES,
  MOTION_EASE_VALUES,
  OVERLAY_TYPE_VALUES,
  OVERLAY_TRIGGER_VALUES,
  OVERLAY_DISMISS_VALUES,
  appearReveal,
} from './action-layer-rich';
import { toProviderTools, toHostToolDescriptors } from './schema';
import { ALL_TOOLS } from './index';
import { appearReveal as realAppearReveal } from '@/editor/tools/AnimationTool/appear-utils';
import { resolveScope } from '@/code/animations/animation-scope';
import { getSortedBreakpointWidths } from '@/code/stores/viewport-store';
import { DEFAULT_VIEWPORT_WIDTH } from '@/shared/constants';
import { bindToCmsCollectionInCode } from '@/code/generation/map-gen';
import { setLoopInCode } from '@/code/generation/generator-motion';
import { updateMotionPropInCode } from '@/code/generation/generator-motion';
import { createPageFile } from '@/code/project/active-file-store';
import { getDefaultStore } from 'jotai';
import { resetProjectFS, projectFS } from '@/code/project/project-fs';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import { gateTurnFiles } from '@/code/oracle/gate';
import { getNodesSnapshot } from '@/code/stores/store';
import { parseVariantConfig } from '@/code/variants/variant-config';
import type { CanvasNode } from '@/code/parsing/parser';

vi.mock('@/code/mutation/mutation-queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/code/mutation/mutation-queue')>();
  return {
    ...actual,
    queueMutation: vi.fn(),
    flushNow: vi.fn(),
    getCurrentCode: vi.fn(() => ''),
  };
});

vi.mock('@/code/project/active-file-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/code/project/active-file-store')>();
  return {
    ...actual,
    createPageFile: vi.fn(() => 'app/about/page.client.tsx'),
  };
});

vi.mock('@/code/stores/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/code/stores/store')>();
  return {
    ...actual,
    getNodesSnapshot: vi.fn(),
  };
});

function makeCtx(): ToolContext {
  return { ensureCheckpoint: vi.fn(), vpWidth: 1440, signal: new AbortController().signal };
}

function schemaOf(tool: AgentTool) {
  return z.object(tool.inputSchema);
}

/** The exact validation gate (tool-exec.ts: z.object(inputSchema).parse). */
function parseInput(tool: AgentTool, input: Record<string, unknown>) {
  return schemaOf(tool).safeParse(input);
}

const M = vi.mocked;

beforeEach(() => {
  vi.clearAllMocks();
  M(getCurrentCode).mockReturnValue('');
  M(getNodesSnapshot).mockReturnValue(new Map<string, CanvasNode>([
    ['btn1', { id: 'btn1', type: 'button' } as unknown as CanvasNode],
  ]));
});

// ─── set_motion_preset: payload parity with AnimationTool handleAdd ─────────

const APPENDED_PAGE = (body: string) =>
  ['export default function Page() {', '  return (', body, '  );', '}'].join('\n');

/** A page whose hero node carries authored styles (the appear-reveal case:
 *  an aura authored at opacity 0.2 must reveal to 0.2, not 1). */
const AURA_PAGE = APPENDED_PAGE(
  '<div data-id="root" data-name="Page">\n    <div data-id="aura" style={{ position: "relative", opacity: 0.2 }}>glow</div>\n  </div>',
);

describe('set_motion_preset — payload parity', () => {
  it("effect 'hover' queues exactly the panel's whileHover scale seed (1.05)", async () => {
    await setMotionPresetTool.execute({ node_id: 'n1', effect: 'hover' }, makeCtx());
    expect(queueMutation).toHaveBeenCalledTimes(1);
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'updateMotionProp', nodeId: 'n1', propName: 'whileHover', props: { scale: '1.05' }, scope: null,
    }, expect.anything());
    expect(flushNow).toHaveBeenCalledTimes(1);
  });

  it("effect 'tap' queues exactly the panel's whileTap scale seed (0.95); scale overrides the seed", async () => {
    await setMotionPresetTool.execute({ node_id: 'n1', effect: 'tap' }, makeCtx());
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'updateMotionProp', nodeId: 'n1', propName: 'whileTap', props: { scale: '0.95' }, scope: null,
    }, expect.anything());
    vi.clearAllMocks();
    await setMotionPresetTool.execute({ node_id: 'n1', effect: 'tap', scale: 0.8 }, makeCtx());
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'updateMotionProp', nodeId: 'n1', propName: 'whileTap', props: { scale: '0.8' }, scope: null,
    }, expect.anything());
  });

  it("effect 'appear' queues the panel's three seeds (initial / derived whileInView / viewport once)", async () => {
    await setMotionPresetTool.execute({ node_id: 'n1', effect: 'appear' }, makeCtx());
    expect(queueMutation).toHaveBeenCalledTimes(3);
    expect(queueMutation).toHaveBeenNthCalledWith(1, {
      type: 'updateMotionProp', nodeId: 'n1', propName: 'initial', props: { opacity: '0', y: '30' }, scope: null,
    }, expect.anything());
    expect(queueMutation).toHaveBeenNthCalledWith(2, {
      type: 'updateMotionProp', nodeId: 'n1', propName: 'whileInView', props: { opacity: '1', y: '0' },
    }, expect.anything());
    expect(queueMutation).toHaveBeenNthCalledWith(3, {
      type: 'updateMotionProp', nodeId: 'n1', propName: 'viewport', props: { once: 'true' },
    }, expect.anything());
  });

  it("appear reveal honors the node's AUTHORED styles (the 2026-07-27 aura rule), like the panel's appearReveal", async () => {
    M(getCurrentCode).mockReturnValue(AURA_PAGE);
    await setMotionPresetTool.execute({ node_id: 'aura', effect: 'appear' }, makeCtx());
    expect(queueMutation).toHaveBeenNthCalledWith(2, {
      type: 'updateMotionProp', nodeId: 'aura', propName: 'whileInView', props: { opacity: '0.2', y: '0' },
    }, expect.anything());
  });

  it("local appearReveal ≡ the real appear-utils appearReveal (parity, incl. authored + neutral keys)", () => {
    const samples: (Record<string, string> | undefined)[] = [undefined, {}, { opacity: '0.2' }, { rotate: '90' }, { opacity: '', y: '' }];
    for (const styles of samples) {
      expect(appearReveal(['opacity', 'y', 'rotate'], styles)).toEqual(realAppearReveal(['opacity', 'y', 'rotate'], styles));
    }
    expect(appearReveal(['scale', 'x'], { scale: '1.1' })).toEqual(realAppearReveal(['scale', 'x'], { scale: '1.1' }));
  });

  it("effect 'loop' queues the panel's rotate-spin seed with its exact transition (2s linear repeat Infinity)", async () => {
    await setMotionPresetTool.execute({ node_id: 'n1', effect: 'loop' }, makeCtx());
    expect(queueMutation).toHaveBeenCalledTimes(1);
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'updateLoop',
      nodeId: 'n1',
      spec: { props: { rotate: '360' }, transition: { duration: '2', repeat: 'Infinity', ease: 'linear' } },
    }, expect.anything());
  });

  it('loop respects transition overrides; appear/hover/tap ignore them', async () => {
    await setMotionPresetTool.execute({ node_id: 'n1', effect: 'loop', transition: { duration: 3.5, ease: 'backOut' } }, makeCtx());
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'updateLoop', nodeId: 'n1',
      spec: { props: { rotate: '360' }, transition: { duration: '3.5', repeat: 'Infinity', ease: 'backOut' } },
    }, expect.anything());
  });

  it('viewport arg scopes value props with the panel resolveScope query (null on desktop)', async () => {
    const tablet = resolveScope({ kind: 'viewports', widths: [768] }, getSortedBreakpointWidths());
    // Band seam: canvas-poc writes the FRACTIONAL lower bound (375.02px), not
    // the legacy integer 376px the fork asserted — see animation-scope.ts, the
    // fix for the integer band hole. Both encode "just above 375"; only the
    // fractional form is emitted now.
    // Panel parity: the scope IS resolveScope(...) with the project breakpoints —
    // with the default [1440, 768, 375] the 768 replica bands to max-768 min-376.
    expect(tablet).toMatchObject({ query: '(max-width: 768px) and (min-width: 375.02px)' });
    await setMotionPresetTool.execute({ node_id: 'n1', effect: 'hover', viewport: 768 }, makeCtx());
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'updateMotionProp', nodeId: 'n1', propName: 'whileHover', props: { scale: '1.05' }, scope: tablet,
    }, expect.anything());

    vi.clearAllMocks();
    await setMotionPresetTool.execute({ node_id: 'n1', effect: 'loop', viewport: 375 }, makeCtx());
    const mobile = resolveScope({ kind: 'viewports', widths: [375] }, getSortedBreakpointWidths());
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'updateLoop', nodeId: 'n1',
      spec: { props: { rotate: '360' }, transition: { duration: '2', repeat: 'Infinity', ease: 'linear' }, scope: [mobile] },
    }, expect.anything());

    vi.clearAllMocks();
    await setMotionPresetTool.execute({ node_id: 'n1', effect: 'hover', viewport: DEFAULT_VIEWPORT_WIDTH }, makeCtx());
    expect(queueMutation).toHaveBeenCalledWith(expect.objectContaining({ scope: null }), expect.anything());
  });

  it('motion payloads land in real page code via the real generators (loop + appear + hover)', () => {
    const base = APPENDED_PAGE('<div data-id="root" data-name="Page">\n    <div data-id="n1">box</div>\n  </div>');
    let code = setLoopInCode(base, 'n1', { props: { rotate: '360' }, transition: { duration: '2', repeat: 'Infinity', ease: 'linear' } });
    expect(code).toContain('data-loop=');
    code = updateMotionPropInCode(code, 'n1', 'whileHover', { scale: '1.05' });
    expect(code).toContain('whileHover');
    expect(code).toContain('scale: 1.05');
    code = updateMotionPropInCode(code, 'n1', 'initial', { opacity: '0', y: '30' });
    expect(code).toContain('initial');
  });

  it('ANTI-PERMISSIVITY: unknown preset and non-panel ease are rejected at schema level', () => {
    expect(parseInput(setMotionPresetTool, { node_id: 'n1', effect: 'spin' }).success).toBe(false);
    expect(parseInput(setMotionPresetTool, { node_id: 'n1', effect: 'loop', transition: { ease: 'custom' } }).success).toBe(false);
    expect(parseInput(setMotionPresetTool, { node_id: 'n1', effect: 'loop', transition: { duration: 0 } }).success).toBe(false);
    expect(parseInput(setMotionPresetTool, { node_id: 'n1', effect: 'hover' }).success).toBe(true);
  });
});

// ─── create_overlay: payload parity with OverlayTool handleCreate ──────────

describe('create_overlay — payload parity', () => {
  /** Execute and return the recorded createOverlay mutation (the id counter is
   *  module-lifetime state, same as the panel's — tests assert against the
   *  ACTUAL generated id instead of assuming a specific counter value). */
  async function runCreate(input: Record<string, unknown>): Promise<CreateOverlayMutation> {
    await createOverlayTool.execute(input, makeCtx());
    const call = M(queueMutation).mock.calls[0] as [CreateOverlayMutation];
    expect(call).toBeTruthy();
    return call[0];
  }

  it('queues exactly the OverlayTool payload with the panel defaults (relative dropdown, click/outside)', async () => {
    const mutation = await runCreate({ node_id: 'btn1' });
    expect(mutation).toMatchObject({
      type: 'createOverlay',
      triggerId: 'btn1',
      overlayConfig: {
        type: 'relative', triggerId: 'btn1', side: 'bottom', align: 'center', offsetX: 0, offsetY: 10,
      },
      triggerConfig: { trigger: 'click', dismiss: 'outside' },
      canvasNode: false,
    });
    expect(mutation.overlayId).toMatch(/^overlay-btn1-\d+$/);
    expect(mutation.triggerConfig.targetId).toBe(mutation.overlayId);
    expect(flushNow).toHaveBeenCalledTimes(1);
  });

  it('honors type/trigger/dismiss overrides; returns the overlay id', async () => {
    const mutation = await runCreate({ node_id: 'btn1', type: 'fixed', trigger: 'hover', dismiss: 'escape' });
    expect(mutation.overlayConfig).toMatchObject({ type: 'fixed' });
    expect(mutation.triggerConfig).toEqual({ targetId: mutation.overlayId, trigger: 'hover', dismiss: 'escape' });
    const r = await createOverlayTool.execute({ node_id: 'btn1', type: 'fixed', trigger: 'hover', dismiss: 'escape' }, makeCtx());
    expect(JSON.parse((r.content[0] as any).text)).toMatchObject({ overlay_id: expect.stringMatching(/^overlay-btn1-\d+$/), type: 'fixed' });
  });

  it('overlay id generator skips ids already in the live code (generateOverlayId parity)', async () => {
    // Fresh module instance → counter starts at 0 → candidate is overlay-btn1-1,
    // which the live code still contains (half-removal) → must skip to -2.
    M(getCurrentCode).mockReturnValue('<div data-id="overlay-btn1-1"></div>');
    vi.resetModules();
    const fresh = await import('./action-layer-rich');
    const freshTool = fresh.createOverlayTool as AgentTool;
    freshTool.execute({ node_id: 'btn1' }, makeCtx());
    const call = M(queueMutation).mock.calls[0] as [CreateOverlayMutation];
    expect(call[0].overlayId).toBe('overlay-btn1-2');
  });

  it('ANTI-PERMISSIVITY: unknown type, trigger or dismiss are rejected; no delay field exists', async () => {
    expect(parseInput(createOverlayTool, { node_id: 'n', type: 'modal' }).success).toBe(false);
    expect(parseInput(createOverlayTool, { node_id: 'n', trigger: 'event' }).success).toBe(false);
    expect(parseInput(createOverlayTool, { node_id: 'n', dismiss: 'outside' }).success).toBe(true);
    const [schema] = toProviderTools([createOverlayTool]);
    expect((schema.input_schema.properties as Record<string, unknown>).delay).toBeUndefined();
  });
});

// ─── set_variant: payload parity with ControlProvider ──────────────────────
// set_variant writes variants on the component MASTER (the panel's variant
// viewport only exists on master files) — so the parity tests run with the
// active file set to a component master.

const CARD_MASTER = `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'hover', label: 'Hover', x: 0, y: 0 },
  { name: 'alert', label: 'Alert', x: 0, y: 0 },
];

export default function Card() {
  return <div data-id="card" data-name="Card" />;
}
`;

describe('set_variant — payload parity', () => {
  beforeEach(() => {
    resetProjectFS(new Map<string, string>([['components/Card.tsx', CARD_MASTER]]));
    getDefaultStore().set(activeFilePathAtom, 'components/Card.tsx');
    M(getCurrentCode).mockReturnValue(CARD_MASTER);
  });

  afterEach(() => {
    getDefaultStore().set(activeFilePathAtom, 'app/page.client.tsx');
  });

  it('writes updateVariantStyle with nodeId + variantName (the ControlProvider write), "" removes a property', async () => {
    await setVariantTool.execute({ node_id: 'card', variant: 'hover', styles: { backgroundColor: '#111111', padding: '' } }, makeCtx());
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'updateVariantStyle', nodeId: 'card', variantName: 'hover', styles: { backgroundColor: '#111111', padding: '' },
    }, expect.anything());
  });

  it('writes updateVariantText for text; both fields in one call produce both mutations', async () => {
    await setVariantTool.execute({ node_id: 'card', variant: 'hover', text: 'Shop now' }, makeCtx());
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'updateVariantText', nodeId: 'card', variantName: 'hover', text: 'Shop now',
    }, expect.anything());
    vi.clearAllMocks();
    await setVariantTool.execute({ node_id: 'card', variant: 'alert', styles: { color: '#f00' }, text: 'Error' }, makeCtx());
    expect(queueMutation).toHaveBeenNthCalledWith(1, {
      type: 'updateVariantStyle', nodeId: 'card', variantName: 'alert', styles: { color: '#f00' },
    }, expect.anything());
    expect(queueMutation).toHaveBeenNthCalledWith(2, {
      type: 'updateVariantText', nodeId: 'card', variantName: 'alert', text: 'Error',
    }, expect.anything());
  });

  it('fails when neither styles nor text is provided', async () => {
    const r = await setVariantTool.execute({ node_id: 'card', variant: 'hover' }, makeCtx());
    expect(r.isError).toBe(true);
  });
});

// ─── set_variant: page instance → master redirect (n1-variant-styling) ────
// The bench scenario: style the DARK variant of a CtaButton instance from a
// page. The variant axis lives in the master — the tool must write the master
// (variants object + per-variant text ternary) and leave the page untouched,
// and BOTH files must pass the real oracle gate (zero violations).

const N1_CANVAS = `/** @canvas { "viewports": [{ "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 }, { "id": "tablet", "label": "Tablet", "width": 768, "isPrimary": false, "order": 1 }, { "id": "mobile", "label": "Mobile", "width": 375, "isPrimary": false, "order": 2 }], "positions": { "desktop": { "x": 0, "y": 0 }, "tablet": { "x": 1480, "y": 0 }, "mobile": { "x": 2288, "y": 0 } } } */`;

const N1_CTA_PAGE = `'use client';

${N1_CANVAS}

import React from 'react';
import CtaButton from '@/components/CtaButton';

export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', minHeight: '900px', display: 'flex', flexDirection: 'column' }}>
      <div data-id="hero" data-name="Hero" style={{ position: 'relative', flex: '0 0 auto', order: '0', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '24px', padding: '120px 40px' }}>
        <CtaButton data-id="cta" style={{ position: 'relative', flex: '0 0 auto', order: '3' }} />
      </div>
    </div>
  );
}`;

const N1_CTA_MASTER = `import React from 'react';
import { motion } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'dark', label: 'Dark', x: 0, y: 0 },
];

const ctaVariants = {
  default: { backgroundColor: '#6366f1', color: '#ffffff' },
  dark: { backgroundColor: '#111827', color: '#ffffff' },
};

/** @name "CtaButton" */
function CtaButton({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (
    <motion.button
      data-id="cta-root"
      variants={ctaVariants}
      initial={['default', initialVariant]}
      animate={['default', initialVariant]}
      style={{ padding: '14px 36px', borderRadius: '8px', border: 'none', cursor: 'pointer', fontSize: '16px', backgroundColor: '#6366f1', color: '#ffffff', ...style }}
    >
      Get Started
    </motion.button>
  );
}

export default withResponsiveProps(CtaButton);
`;

describe('set_variant — page instance redirect into the master (n1-variant-styling)', () => {
  beforeEach(() => {
    resetProjectFS(
      new Map<string, string>([
        ['app/page.client.tsx', N1_CTA_PAGE],
        ['components/CtaButton.tsx', N1_CTA_MASTER],
      ]),
    );
    getDefaultStore().set(activeFilePathAtom, 'app/page.client.tsx');
    M(getCurrentCode).mockReturnValue(N1_CTA_PAGE);
  });

  afterEach(() => {
    getDefaultStore().set(activeFilePathAtom, 'app/page.client.tsx');
  });

  it('writes the dark variant into the MASTER — page untouched, both files pass the real oracle gate', async () => {
    const r = await setVariantTool.execute(
      { node_id: 'cta', variant: 'dark', styles: { backgroundColor: '#0f172a', color: '#ffffff' }, text: 'Get Started Now' },
      makeCtx(),
    );
    expect(r.isError).toBeFalsy();
    expect(JSON.stringify(r.content)).toContain('master_path');

    // The PAGE is untouched — no ternaries, no initialVariant reference.
    const page = projectFS.readFile('app/page.client.tsx');
    expect(page).toBe(N1_CTA_PAGE);
    expect(page).not.toContain('initialVariant');

    // The MASTER carries the variant write: dark entry in the variants object
    // (with or without quoted keys) + the per-variant text ternary.
    const master = projectFS.readFile('components/CtaButton.tsx');
    expect(master).toMatch(/'?dark'?\s*:\s*\{\s*backgroundColor:\s*'#0f172a'/);
    expect(master).toMatch(/initialVariant\s*===\s*["']dark["']\s*\?\s*["']Get Started Now["']/);

    // The bench's n1-variant-styling satisfiesFiles predicate accepts this outcome.
    expect(master).toMatch(/'?dark'?\s*:\s*\{\s*[^}]*#0f172a/);

    // The REAL oracle gate accepts both files with zero violations.
    const gate = gateTurnFiles(
      [
        { path: 'components/CtaButton.tsx', kind: 'component', code: master ?? '' },
        { path: 'app/page.client.tsx', kind: 'page', code: page ?? '' },
      ],
      'app/page.client.tsx',
    );
    expect(gate.violations).toEqual([]);
  });

  it('rejects a variant name that does not exist on the master (anti-permissivity) and changes nothing', async () => {
    const r = await setVariantTool.execute(
      { node_id: 'cta', variant: 'teal', styles: { backgroundColor: '#14b8a6' } },
      makeCtx(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('not a variant');
    expect(projectFS.readFile('components/CtaButton.tsx')).toBe(N1_CTA_MASTER);
    expect(projectFS.readFile('app/page.client.tsx')).toBe(N1_CTA_PAGE);
    expect(queueMutation).not.toHaveBeenCalled();
  });

  it('rejects a plain (non-instance) element on a page', async () => {
    const r = await setVariantTool.execute({ node_id: 'hero', variant: 'dark', styles: { color: '#ffffff' } }, makeCtx());
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('component INSTANCE');
  });
});

// ─── bind_cms_list / bind_cms_field: payload parity with the CMS drop ──────

const BOUND_LIST_PAGE = APPENDED_PAGE(
  `<div data-id="root" data-name="Page">
    <div data-id="list">
      {blog.map((item, idx) => (
        <div data-id="card" key={idx}>
          <h2 data-id="title">Title</h2>
        </div>
      ))}
    </div>
  </div>`,
);

describe('bind_cms_list — payload parity', () => {
  it('queues exactly bindToCmsCollection (the Insert > CMS drop write)', async () => {
    await bindCmsListTool.execute({ node_id: 'card', collection_slug: 'blog' }, makeCtx());
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'bindToCmsCollection', nodeId: 'card', collectionSlug: 'blog',
    }, expect.anything());
    expect(flushNow).toHaveBeenCalledTimes(1);
  });

  it('the exact payload lands in real page code via the real generator', () => {
    const base = APPENDED_PAGE('<div data-id="root" data-name="Page">\n    <div data-id="list">\n      <div data-id="card">Card</div>\n    </div>\n  </div>');
    const out = bindToCmsCollectionInCode(base, 'card', 'blog');
    expect(out).toContain('blog.map((item, idx) =>');
    expect(out).toContain("import blog from '@/cms/blog.json';");
    expect(out).toContain('data-id="card" key={idx}');
  });
});

describe('bind_cms_field — payload parity', () => {
  it('resolves the item var from the code (BindButton gets itemVar from context; the tool derives it) and emits bindField', async () => {
    M(getCurrentCode).mockReturnValue(BOUND_LIST_PAGE);
    await bindCmsFieldTool.execute({ node_id: 'title', field_id: 'title', property: 'text' }, makeCtx());
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'bindField', nodeId: 'title', property: 'text', fieldId: 'title', itemVar: 'item',
    }, expect.anything());
  });

  it('fails when the node is not inside any .map() (property check before any mutation)', async () => {
    M(getCurrentCode).mockReturnValue(APPENDED_PAGE('<div data-id="root" data-name="Page">\n    <h2 data-id="title">Title</h2>\n  </div>'));
    const r = await bindCmsFieldTool.execute({ node_id: 'title', field_id: 'title', property: 'text' }, makeCtx());
    expect(r.isError).toBe(true);
    expect(queueMutation).not.toHaveBeenCalled();
  });
});

// ─── set_form: payload parity with FormStateTool ───────────────────────────

const FORM_PAGE = APPENDED_PAGE(
  `<div data-id="root" data-name="Page">
    <form data-id="f1" name="Contact">
      <input data-id="email" />
      <Hero data-id="submit" />
    </form>
  </div>`,
);

describe('set_form — payload parity', () => {
  it('derives the state var from the enclosing form (formStateVar(formId)) and maps states → variant names', async () => {
    M(getCurrentCode).mockReturnValue(FORM_PAGE);
    await setFormTool.execute({ node_id: 'submit', states: { loading: 'loading', success: 'success' } }, makeCtx());
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'setFormStateMapping',
      nodeId: 'submit',
      stateVar: 'formStateF1',
      mapping: { loading: 'loading', success: 'success' },
    }, expect.anything());
    expect(flushNow).toHaveBeenCalledTimes(1);
  });

  it('unmaps a state with "" and rejects an all-"" mapping', async () => {
    M(getCurrentCode).mockReturnValue(FORM_PAGE);
    await setFormTool.execute({ node_id: 'submit', states: { loading: '', success: 'done' } }, makeCtx());
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'setFormStateMapping', nodeId: 'submit', stateVar: 'formStateF1', mapping: { success: 'done' },
    }, expect.anything());
    vi.clearAllMocks();
    const r = await setFormTool.execute({ node_id: 'submit', states: { loading: '' } }, makeCtx());
    expect(r.isError).toBe(true);
    expect(queueMutation).not.toHaveBeenCalled();
  });

  it('fails when the node is not inside a form (the panel derives formId the same way)', async () => {
    M(getCurrentCode).mockReturnValue(APPENDED_PAGE('<div data-id="root" data-name="Page">\n    <Hero data-id="submit" />\n  </div>'));
    const r = await setFormTool.execute({ node_id: 'submit', states: { success: 'success' } }, makeCtx());
    expect(r.isError).toBe(true);
    expect(queueMutation).not.toHaveBeenCalled();
  });

  it('ANTI-PERMISSIVITY: an unknown lifecycle state cannot be mapped (schema-pinned FORM_STATES)', async () => {
    expect(parseInput(setFormTool, { node_id: 'submit', states: { hover: 'x' } }).success).toBe(false);
    expect(parseInput(setFormTool, { node_id: 'submit', states: { success: 'success', bogus: 'x' } }).success).toBe(false);
    expect(parseInput(setFormTool, { node_id: 'submit', states: { success: 'success' } }).success).toBe(true);
  });
});

// ─── create_page: parity with the editor + New Page action ─────────────────

describe('create_page — parity', () => {
  it('calls createPageFile (the FileExplorer / menu-builders action) and returns the client path', async () => {
    const r = await createPageTool.execute({ name: 'About' }, makeCtx());
    expect(createPageFile).toHaveBeenCalledWith('About', undefined);
    expect(JSON.parse((r.content[0] as any).text)).toMatchObject({ path: 'app/about/page.client.tsx', route: '/about' });
  });

  it('passes the group dir through for nested routes; arms the checkpoint before writing', async () => {
    const ctx = makeCtx();
    await createPageTool.execute({ name: 'Pricing', dir: 'app/blog' }, ctx);
    expect(createPageFile).toHaveBeenCalledWith('Pricing', 'app/blog');
    expect(ctx.ensureCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('ANTI-PERMISSIVITY: name and dir are plain strings; no code content accepted (oracle-gated path is apply_file_edit)', async () => {
    expect(parseInput(createPageTool, { name: 42 }).success).toBe(false);
    expect(parseInput(createPageTool, { code: '<div/>' }).success).toBe(true); // unknown key ignored by zod (default)
  });
});

// ─── Registration + surface ────────────────────────────────────────────────

describe('rich action layer — registration & enums', () => {
  it('all nine tools are in ALL_TOOLS with unique names on both channels', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    for (const n of ['set_motion_preset', 'create_overlay', 'set_variant', 'create_variant', 'extract_component', 'bind_cms_list', 'bind_cms_field', 'set_form', 'create_page']) {
      expect(names).toContain(n);
    }
    expect(new Set(names).size).toBe(names.length);
    const providerNames = toProviderTools(ALL_TOOLS).map((t) => t.name);
    const hostNames = toHostToolDescriptors(ALL_TOOLS).map((t) => t.name);
    expect(providerNames).toEqual(hostNames);
  });

  it('enums mirror the panel option sets (anti-invention)', () => {
    expect(MOTION_PRESET_VALUES).toEqual(['appear', 'hover', 'tap', 'loop']);
    expect(MOTION_EASE_VALUES).toEqual(['easeOut', 'easeIn', 'easeInOut', 'linear', 'backOut', 'backIn', 'circOut', 'circIn', 'anticipate']);
    expect(MOTION_EASE_VALUES).not.toContain('custom');
    expect(OVERLAY_TYPE_VALUES).toEqual(['relative', 'fixed']);
    expect(OVERLAY_TRIGGER_VALUES).toEqual(['click', 'hover']);
    expect(OVERLAY_DISMISS_VALUES).toEqual(['outside', 'click', 'escape']);
  });

  it('every RICH tool frames its schema with node_id (or the *_id analog) and serializes', () => {
    for (const tool of RICH_ACTION_TOOLS) {
      const [provider] = toProviderTools([tool]);
      expect(provider.name).toBe(tool.name);
      expect(provider.input_schema.properties).toBeTruthy();
    }
  });
});

// ─── create_variant — declaration half of the variant axis (CAP-01) ─────────
// Wraps the SAME variant-ops the editor's Add Variant actions run, so the
// produced master is exactly what set_variant and the variant viewport
// operate. The S7-acceptance test below is the P4 proof: a plain master gains
// a variant, then set_variant stops failing on it.

const PLAIN_MASTER = `"use client";

import { withResponsiveProps } from "@revyme/runtime";

/** @name "Card" */
export const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
];

function Card({ style, title = "Hello" }: { style?: React.CSSProperties; title?: string }) {
  return (
    <div data-id="card" style={{ position: 'relative', order: '0', flex: '0 0 auto', ...style }}>
      {title}
    </div>
  );
}

export default withResponsiveProps(Card);
`;

describe('create_variant — declaration parity with the editor Add Variant', () => {
  beforeEach(() => {
    resetProjectFS(new Map<string, string>([['components/Card.tsx', PLAIN_MASTER]]));
    getDefaultStore().set(activeFilePathAtom, 'components/Card.tsx');
    M(getCurrentCode).mockReturnValue(PLAIN_MASTER);
  });

  afterEach(() => {
    getDefaultStore().set(activeFilePathAtom, 'app/page.client.tsx');
  });

  it('declares the variant on the master (S7-acceptance: set_variant stops failing)', async () => {
    const r = await createVariantTool.execute({ component: 'Card', variant: 'featured' }, makeCtx());
    expect(r.isError).not.toBe(true);
    const after = projectFS.readFile('components/Card.tsx') ?? '';
    expect(after).toContain("name: 'featured'");
    // Plain master: no motion wiring yet — honestly reported, not hidden.
    const body = JSON.parse((r.content[0] as { text: string }).text);
    expect(body.motion_wiring).toBe(false);
    expect(body.note).toMatch(/set_variant[^]*element[^]*show_variant/);
    // And now the switcher accepts it on the same master.
    await setVariantTool.execute(
      { node_id: 'card', variant: 'featured', styles: { backgroundColor: '#eef0ff' } },
      makeCtx(),
    );
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'updateVariantStyle',
      nodeId: 'card',
      variantName: 'featured',
      styles: { backgroundColor: '#eef0ff' },
    }, expect.anything());
  });

  it('creates a wired hover interaction state with the editor chain rule', async () => {
    const r = await createVariantTool.execute(
      { component: 'Card', variant: 'ignored-name', interaction: 'hover', interaction_parent: 'default' },
      makeCtx(),
    );
    expect(r.isError).not.toBe(true);
    const after = projectFS.readFile('components/Card.tsx') ?? '';
    expect(after).toContain('default-hover');
    // Wired, not just declared: connections + trigger handler landed.
    expect(after).toMatch(/const connections\s*=/);
    expect(after).toMatch(/mouseEnter/);
  });

  it('refuses duplicates, missing components, code components and bad names', async () => {
    const dup = await createVariantTool.execute({ component: 'Card', variant: 'default' }, makeCtx());
    expect(dup.isError).toBe(true);
    const miss = await createVariantTool.execute({ component: 'Nope', variant: 'featured' }, makeCtx());
    expect(miss.isError).toBe(true);
    const bad = await createVariantTool.execute({ component: 'Card', variant: '9bad' }, makeCtx());
    expect(bad.isError).toBe(true);
  });

  it('S7-replay: page-side set_variant on the created variant lands (healed plumbing)', async () => {
    const page = `'use client';
import Card from '@/components/Card';
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative' }}>
      <Card data-id="inst1" />
    </div>
  );
}`;
    resetProjectFS(
      new Map<string, string>([
        ['app/page.client.tsx', page],
        ['components/Card.tsx', PLAIN_MASTER],
      ]),
    );
    getDefaultStore().set(activeFilePathAtom, 'app/page.client.tsx');
    M(getCurrentCode).mockReturnValue(page);
    M(getNodesSnapshot).mockReturnValue(
      new Map<string, CanvasNode>([
        ['root', { id: 'root', type: 'div', children: ['inst1'] } as unknown as CanvasNode],
        ['inst1', { id: 'inst1', type: 'Card', parentId: 'root' } as unknown as CanvasNode],
      ]),
    );
    const created = await createVariantTool.execute({ component: 'Card', variant: 'featured' }, makeCtx());
    expect(created.isError).not.toBe(true);
    // The full chain lands through the REAL modifyProjectFile + oracle gate:
    // the writer declares the missing initialVariant param itself.
    const r = await setVariantTool.execute(
      { node_id: 'inst1', variant: 'featured', styles: { backgroundColor: '#eef0ff' } },
      makeCtx(),
    );
    expect(r.isError).not.toBe(true);
    const master = projectFS.readFile('components/Card.tsx') ?? '';
    expect(master).toContain("initialVariant = 'default'");
    expect(master).toContain('#eef0ff');
  });
});

// ─── extract_component — human-parity extraction (CAP-01) ───────────────────
// Master authored by the generator (oracle-canonical, variant plumbing
// included), page swap via the same addNode/removeNode the instance tools
// use — with props known from generation, so no registry staleness window.

const EXTRACT_PAGE = `export default function Page() {
  return (
    <div data-id="root">
      <section
        data-id="hero-section"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: '96px 24px',
        }}
      >
        <div data-id="hero-eyebrow" style={{ position: 'relative', order: '0', flex: '0 0 auto' }}>Builder visuel</div>
        <h1 data-id="hero-title" style={{ position: 'relative', order: '1', flex: '0 0 auto' }}>Dessinez votre site.</h1>
      </section>
    </div>
  );
}
`;

function seedExtractPage(code: string = EXTRACT_PAGE) {
  resetProjectFS(new Map<string, string>([['app/page.client.tsx', code]]));
  getDefaultStore().set(activeFilePathAtom, 'app/page.client.tsx');
  M(getCurrentCode).mockReturnValue(code);
  M(getNodesSnapshot).mockReturnValue(
    new Map<string, CanvasNode>([
      ['root', { id: 'root', type: 'div', children: ['hero-section'] } as unknown as CanvasNode],
      ['hero-section', { id: 'hero-section', type: 'section', parentId: 'root' } as unknown as CanvasNode],
    ]),
  );
}

describe('extract_component — human-parity extraction', () => {
  afterEach(() => {
    getDefaultStore().set(activeFilePathAtom, 'app/page.client.tsx');
  });

  it('authors a gated master and swaps an instance in place', async () => {
    seedExtractPage();
    const r = await extractComponentTool.execute({ node_id: 'hero-section', name: 'Hero' }, makeCtx());
    expect(r.isError).not.toBe(true);
    const master = projectFS.readFile('components/Hero.tsx') ?? '';
    expect(master).toContain('function Hero({');
    expect(master).toContain("name: 'default'");
    // In place: instance added at index 0, original removed.
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'addNode',
      parentId: 'root',
      node: expect.objectContaining({ type: 'Hero', attrs: {} }),
      index: 0,
    }, expect.anything());
    expect(queueMutation).toHaveBeenCalledWith({ type: 'removeNode', nodeId: 'hero-section' }, expect.anything());
    const body = JSON.parse((r.content[0] as { text: string }).text);
    expect(body.master).toBe('components/Hero.tsx');
    expect(body.props).toEqual(expect.arrayContaining(['heroEyebrow', 'heroTitle']));
  });

  it('refuses unknown nodes, bad names, existing files and the page root', async () => {
    seedExtractPage();
    expect((await extractComponentTool.execute({ node_id: 'nope', name: 'Hero' }, makeCtx())).isError).toBe(true);
    expect((await extractComponentTool.execute({ node_id: 'hero-section', name: 'hero' }, makeCtx())).isError).toBe(true);
    resetProjectFS(
      new Map<string, string>([
        ['app/page.client.tsx', EXTRACT_PAGE],
        ['components/Hero.tsx', PLAIN_MASTER],
      ]),
    );
    M(getCurrentCode).mockReturnValue(EXTRACT_PAGE);
    expect((await extractComponentTool.execute({ node_id: 'hero-section', name: 'Hero' }, makeCtx())).isError).toBe(true);
  });

  it('surfaces oracle bounces instead of committing a malformed master', async () => {
    const computed = EXTRACT_PAGE.replace('Dessinez votre site.', '{a + b}');
    seedExtractPage(computed);
    const r = await extractComponentTool.execute({ node_id: 'hero-section', name: 'Hero' }, makeCtx());
    expect(r.isError).toBe(true);
    expect(projectFS.exists('components/Hero.tsx')).toBe(false);
  });
});
// ─── create_component — greenfield declarative authoring (P7 Ib-3) ──────────
// Thin wrapper over the canonical emitter: same gate+commit honesty as
// extract_component (gateTurnFiles → commitTurnFiles → written check), page
// untouched (no instance swap), editability verdict surfaced (I8').

const CREATE_PAGE = `'use client';
/** @canvas { "viewports": [], "positions": {} } */
import React from 'react';
export default function Page() {
  return (
    <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}>
      <div data-id="plan" data-name="Plan" style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
        <p data-id="plan-title" data-name="Title" style={{ position: 'relative', order: '0', flex: '0 0 auto', fontSize: '20px' }}>Pro</p>
        <p data-id="plan-price" data-name="Price" style={{ position: 'relative', order: '1', flex: '0 0 auto', fontSize: '16px' }}>$49</p>
      </div>
    </div>
  );
}`;

describe('create_component — declarative master authoring', () => {
  beforeEach(() => {
    resetProjectFS(new Map<string, string>([['app/page.client.tsx', CREATE_PAGE]]));
    getDefaultStore().set(activeFilePathAtom, 'app/page.client.tsx');
    M(getCurrentCode).mockReturnValue(CREATE_PAGE);
  });

  afterEach(() => {
    getDefaultStore().set(activeFilePathAtom, 'app/page.client.tsx');
  });

  it('layout mode writes the master, returns props, NATIVE editability, page untouched', async () => {
    const r = await createComponentTool.execute(
      {
        name: 'PricingCard',
        props: [
          { name: 'title', type: 'string', default: 'Starter' },
          { name: 'price', type: 'string', default: '$19' },
        ],
        variants: [{ name: 'open' }],
        layout: [
          {
            tag: 'div',
            style: { position: 'relative', display: 'flex', flexDirection: 'column' },
            children: [
              { tag: 'p', text: '{title}', style: { position: 'relative' } },
              { tag: 'p', text: '{price}', style: { position: 'relative' } },
            ],
          },
        ],
      },
      makeCtx(),
    );
    expect(r.isError).toBeUndefined();
    const body = JSON.parse((r.content[0] as { text: string }).text);
    expect(body.master).toBe('components/PricingCard.tsx');
    expect(body.props.map((p: { name: string }) => p.name)).toEqual(['title', 'price']);
    expect(body.variants).toEqual(['default', 'open']);
    expect(body.editability.verdict).toBe('NATIVE');
    expect(body.warning).toBeUndefined();
    const master = projectFS.readFile('components/PricingCard.tsx') ?? '';
    expect(master).toContain('withResponsiveProps(PricingCard)');
    // Page untouched — create authors, never converts.
    expect(projectFS.readFile('app/page.client.tsx')).toBe(CREATE_PAGE);
  });

  it('from mode models the subtree and binds texts in order', async () => {
    const r = await createComponentTool.execute(
      {
        name: 'PlanCard',
        props: [
          { name: 'title', type: 'string', default: 'T' },
          { name: 'price', type: 'string', default: 'P' },
        ],
        from: 'plan',
      },
      makeCtx(),
    );
    expect(r.isError).toBeUndefined();
    const master = projectFS.readFile('components/PlanCard.tsx') ?? '';
    expect(master).toContain('{title}');
    expect(master).toContain('{price}');
    expect(master).not.toContain('>Pro<');
  });

  it('refuses existing names and bad specs with the compiler message', async () => {
    await createComponentTool.execute(
      { name: 'PlanCard', props: [], layout: [{ tag: 'div', style: { position: 'relative' } }] },
      makeCtx(),
    );
    const dup = await createComponentTool.execute(
      { name: 'PlanCard', props: [], layout: [{ tag: 'div', style: { position: 'relative' } }] },
      makeCtx(),
    );
    expect(dup.isError).toBe(true);
    expect(JSON.parse((dup.content[0] as { text: string }).text).error).toContain('already exists');
    const bad = await createComponentTool.execute({ name: 'nope', props: [] }, makeCtx());
    expect(bad.isError).toBe(true);
  });

  it('created master carries operable variant plumbing (set_variant reads it)', async () => {
    await createComponentTool.execute(
      {
        name: 'SwitchCard',
        props: [{ name: 'title', type: 'string', default: 'T' }],
        variants: [{ name: 'featured' }],
        layout: [{ tag: 'p', text: '{title}', style: { position: 'relative' } }],
      },
      makeCtx(),
    );
    const master = projectFS.readFile('components/SwitchCard.tsx') ?? '';
    expect(parseVariantConfig(master).map((v) => v.name)).toEqual(['default', 'featured']);
  });

  it('is registered for the agent and excluded from batch (Ib-3 hors batch)', async () => {
    expect(ALL_TOOLS.map((t) => t.name)).toContain('create_component');
    expect(RICH_ACTION_TOOLS.map((t) => t.name)).toContain('create_component');
    const { buildToolMap } = await import('./registry');
    const { PROPERTY_TOOLS } = await import('./semantic-property');
    const { STRUCTURE_TOOLS } = await import('./semantic-structure');
    const { ACTION_TOOLS } = await import('./action-layer');
    const batchMap = buildToolMap([...PROPERTY_TOOLS, ...STRUCTURE_TOOLS, ...ACTION_TOOLS]);
    expect(batchMap.has('create_component')).toBe(false);
    expect(batchMap.has('extract_component')).toBe(false);
  });
});

describe('create_component review fixes (M1/M2)', () => {
  beforeEach(() => {
    resetProjectFS(new Map<string, string>([['app/page.client.tsx', CREATE_PAGE]]));
    getDefaultStore().set(activeFilePathAtom, 'app/page.client.tsx');
    M(getCurrentCode).mockReturnValue(CREATE_PAGE);
  });

  afterEach(() => {
    getDefaultStore().set(activeFilePathAtom, 'app/page.client.tsx');
  });

  it('M1: omitted props reaches the compiler refusal, not a zod crash', async () => {
    // Static master (no props) succeeds — props truly optional.
    const r = await createComponentTool.execute(
      { name: 'StaticBox', layout: [{ tag: 'div', style: { position: 'relative' } }] },
      makeCtx(),
    );
    expect(r.isError).toBeUndefined();
    expect(projectFS.readFile('components/StaticBox.tsx')).toContain('withResponsiveProps(StaticBox)');
  });

  it('M2: declared variants without motion carry an inert-states note', async () => {
    const r = await createComponentTool.execute(
      {
        name: 'NotedCard',
        props: [{ name: 'title', type: 'string', default: 'T' }],
        variants: [{ name: 'featured' }],
        layout: [{ tag: 'p', text: '{title}', style: { position: 'relative' } }],
      },
      makeCtx(),
    );
    expect(r.isError).toBeUndefined();
    const body = JSON.parse((r.content[0] as { text: string }).text);
    expect(body.note).toContain('no motion wiring');
  });
});

// ─── P8 branched routing ────────────────────────────────────────────────────
// Queue-routed tools carry the branch envelope (proven exactly here); tools
// with direct ProjectFS writes refuse explicitly (whole-file precedent) and
// write nothing — neither main nor the queue.

function makeBranchedCtx(): ToolContext {
  return { ...makeCtx(), workspace: { branchId: 'branch-x', filePath: 'app/page.client.tsx' } };
}

describe('P8 — branched runs', () => {
  const BRANCH = 'branch-x';
  const PAGE = 'app/page.client.tsx';

  function seedBranch(files: Array<[string, string]>) {
    expect(projectFS.createBranch(BRANCH)).toBeNull();
    for (const [path, code] of files) projectFS.writeBranchFile(BRANCH, path, code);
  }

  afterEach(() => {
    resetProjectFS();
  });

  it('set_motion_preset routes the mutation through the branch envelope (scoped flush)', async () => {
    await setMotionPresetTool.execute({ node_id: 'n1', effect: 'hover' }, makeBranchedCtx());
    expect(queueMutation).toHaveBeenCalledWith(
      { type: 'updateMotionProp', nodeId: 'n1', propName: 'whileHover', props: { scale: '1.05' }, scope: null },
      { author: 'agent', file: 'app/page.client.tsx', branchId: 'branch-x' },
    );
    expect(flushNow).toHaveBeenCalledWith({ branchId: 'branch-x' });
  });

  it('extract_component authors the master into the branch map; main untouched; swap routed', async () => {
    seedBranch([[PAGE, EXTRACT_PAGE]]);
    const res = await extractComponentTool.execute({ node_id: 'hero-section', name: 'Hero' }, makeBranchedCtx());
    expect(res.isError).toBeUndefined();
    const master = projectFS.readBranchFile(BRANCH, 'components/Hero.tsx') ?? '';
    expect(master).toContain('withResponsiveProps(Hero)');
    // Main truth untouched: no master on main, no queue write outside the branch.
    expect(projectFS.readFile('components/Hero.tsx')).toBeNull();
    expect(queueMutation).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'addNode' }),
      expect.objectContaining({ author: 'agent', file: PAGE, branchId: BRANCH }),
    );
    expect(flushNow).toHaveBeenCalledWith({ branchId: BRANCH });
    expect(JSON.parse((res.content[0] as { text: string }).text).branch).toBe(BRANCH);
  });

  it('create_component (layout) authors into the branch map; main untouched', async () => {
    seedBranch([[PAGE, CREATE_PAGE]]);
    const res = await createComponentTool.execute(
      {
        name: 'BranchCard',
        props: [{ name: 'title', type: 'string', default: 'Starter' }],
        variants: [{ name: 'open' }],
        layout: [{ tag: 'p', text: '{title}', style: { position: 'relative' } }],
      },
      makeBranchedCtx(),
    );
    expect(res.isError).toBeUndefined();
    const master = projectFS.readBranchFile(BRANCH, 'components/BranchCard.tsx') ?? '';
    expect(master).toContain('withResponsiveProps(BranchCard)');
    expect(parseVariantConfig(master).map((v) => v.name)).toEqual(['default', 'open']);
    expect(projectFS.readFile('components/BranchCard.tsx')).toBeNull();
    expect(projectFS.readBranchFile(BRANCH, PAGE)).toBe(CREATE_PAGE);
    expect(JSON.parse((res.content[0] as { text: string }).text).branch).toBe(BRANCH);
  });

  it('create_variant (plain) declares on the branch master; main master unchanged; interaction refused', async () => {
    seedBranch([[PAGE, CREATE_PAGE], ['components/Card.tsx', PLAIN_MASTER]]);
    const res = await createVariantTool.execute({ component: 'Card', variant: 'featured' }, makeBranchedCtx());
    expect(res.isError).toBeUndefined();
    expect(projectFS.readBranchFile(BRANCH, 'components/Card.tsx')).toContain("name: 'featured'");
    expect(projectFS.readFile('components/Card.tsx')).toBeNull();
    // Auto-wired interaction states stay main-bound (cross-file connection fan-out).
    const wired = await createVariantTool.execute(
      { component: 'Card', variant: 'ignored', interaction: 'hover', interaction_parent: 'default' },
      makeBranchedCtx(),
    );
    expect(wired.isError).toBe(true);
    expect((wired.content[0] as { text: string }).text).toContain('auto-wire');
  });

  it('set_variant master-active on a branch routes the queue write (scoped flush)', async () => {
    seedBranch([['components/Card.tsx', PLAIN_MASTER]]);
    const created = await createVariantTool.execute({ component: 'Card', variant: 'featured' }, makeBranchedCtx());
    expect(created.isError).toBeUndefined();
    const ctx: ToolContext = {
      ...makeBranchedCtx(),
      workspace: { branchId: BRANCH, filePath: 'components/Card.tsx' },
    };
    const res = await setVariantTool.execute(
      { node_id: 'card', variant: 'featured', styles: { backgroundColor: '#eef0ff' } },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    expect(queueMutation).toHaveBeenCalledWith(
      {
        type: 'updateVariantStyle',
        nodeId: 'card',
        variantName: 'featured',
        styles: { backgroundColor: '#eef0ff' },
      },
      expect.objectContaining({ author: 'agent', file: 'components/Card.tsx', branchId: BRANCH }),
    );
    expect(flushNow).toHaveBeenCalledWith({ branchId: BRANCH });
  });

  it('set_variant page-side (instance redirect) commits the branch master; main master unchanged', async () => {
    const page = `'use client';
import Card from '@/components/Card';
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative' }}>
      <Card data-id="inst1" />
    </div>
  );
}`;
    seedBranch([[PAGE, page], ['components/Card.tsx', PLAIN_MASTER]]);
    const created = await createVariantTool.execute({ component: 'Card', variant: 'featured' }, makeBranchedCtx());
    expect(created.isError).toBeUndefined();
    const res = await setVariantTool.execute(
      { node_id: 'inst1', variant: 'featured', styles: { backgroundColor: '#eef0ff' } },
      makeBranchedCtx(),
    );
    expect(res.isError).toBeUndefined();
    expect(JSON.parse((res.content[0] as { text: string }).text).master_path).toBe('components/Card.tsx');
    const branchMaster = projectFS.readBranchFile(BRANCH, 'components/Card.tsx') ?? '';
    expect(branchMaster).toContain('#eef0ff');
    expect(projectFS.readFile('components/Card.tsx')).toBeNull();
    // The page file itself stays untouched on both paths.
    expect(projectFS.readBranchFile(BRANCH, PAGE)).toBe(page);
  });

  it('create_page mints the pair on the branch and virtual-switches the run; main untouched', async () => {
    seedBranch([[PAGE, CREATE_PAGE]]);
    const ctx = makeBranchedCtx();
    const res = await createPageTool.execute({ name: 'Zebra' }, ctx);
    expect(res.isError).toBeUndefined();
    const body = JSON.parse((res.content[0] as { text: string }).text);
    // Seed-independent: assert on the returned path (slug dedup may suffix).
    const clientPath = body.path as string;
    expect(clientPath).toMatch(/^app\/zebra(-2)?\/page\.client\.tsx$/);
    const serverPath = clientPath.replace(/\/page\.client\.tsx$/, '/page.tsx');
    const client = projectFS.readBranchFile(BRANCH, clientPath) ?? '';
    expect(client).toContain('data-id="root"');
    expect(projectFS.readBranchFile(BRANCH, serverPath)).toContain('PageClient');
    expect(projectFS.readFile(clientPath)).toBeNull();
    expect(createPageFile).not.toHaveBeenCalled();
    // Virtual switch (set_page precedent): the run works on the new page now.
    expect(ctx.workspace?.filePath).toBe(clientPath);
    expect(body.branch).toBe(BRANCH);
    expect(body.previous).toBe(PAGE);
  });
});
