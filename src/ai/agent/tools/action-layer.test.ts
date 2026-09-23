// src/ai/agent/tools/action-layer.test.ts
//
// Action-layer primitives (M12): set_layout / set_size / set_position /
// set_typography + set_component_prop variant. Zero LLM, zero BENCH_RUN.
//
// PARITY — the schemas mirror the editor's option sets and write paths. The
// test imports BOTH sides (src/editor is only reachable from tests): the
// enum arrays are asserted equal to the UI's own options
// (css-property-options getAlignOptions/getJustifyOptions), and every
// mutation payload is asserted against the write the corresponding panel
// produces (updateStyles, one per field for layout like the editor's
// per-control onUpdate; setVariantAttr like the Input tool's variant axis).
//
// ANTI-PERMISSIVITY — values the editor cannot represent are rejected at
// schema level (tool-exec validates tool_call args with
// z.object(tool.inputSchema).parse), and the component-prop
// registry check stays execute-level.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { atom } from 'jotai';
import { z } from 'zod';
import { queueMutation, flushNow } from '@/code/mutation/mutation-queue';
import { getNodesSnapshot, selectedIdsAtom } from '@/code/stores/store';
import { projectFS, resetProjectFS } from '@/code/project/project-fs';
import type { CanvasNode } from '@/code/parsing/parser';
import type { AgentTool, ToolContext } from '@/ai/agent';
import {
  setLayoutTool,
  setSizeTool,
  setPositionTool,
  setTypographyTool,
  ACTION_TOOLS,
  LAYOUT_ALIGN_VALUES,
  LAYOUT_JUSTIFY_VALUES,
  LAYOUT_DIRECTION_VALUES,
  LAYOUT_WRAP_VALUES,
  LAYOUT_DISPLAY_VALUES,
  POSITION_MODE_VALUES,
  TEXT_ALIGN_VALUES,
  PX_VALUE_RE,
} from './action-layer';
import { RICH_ACTION_TOOLS } from './action-layer-rich';
import { setComponentPropTool } from './semantic-structure';
import { ALL_TOOLS } from './index';
import { toProviderTools, toHostToolDescriptors } from './schema';
import { getAlignOptions, getJustifyOptions } from '@/editor/controls/css-property-options';
import { buildComponentRegistry } from '@/code/components/component-registry';

vi.mock('@/code/mutation/mutation-queue', () => ({
  queueMutation: vi.fn(),
  flushNow: vi.fn(),
  // P8: les outils routent via queueToolMutation(ctx) qui résout le fichier
  // actif de la queue pour les runs non-branchés (comportement legacy identique).
  getQueueActiveFilePath: vi.fn(() => 'app/page.client.tsx'),
}));

vi.mock('@/code/stores/store', () => ({
  getNodesSnapshot: vi.fn(),
  selectedIdsAtom: atom<string[]>([]),
}));

vi.mock('@/code/components/component-registry', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/code/components/component-registry')>();
  return { ...mod, buildComponentRegistry: vi.fn(() => new Map()) };
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

// ─── PARITY: schema enums ≡ editor option sets ─────────────────────────────

describe('action layer — UI parity', () => {
  it('alignItems enum mirrors getAlignOptions() exactly (no stretch/baseline)', () => {
    const ui = getAlignOptions().map((o) => o.value);
    expect(LAYOUT_ALIGN_VALUES).toEqual(ui);
    expect(ui).not.toContain('stretch');
    expect(ui).not.toContain('baseline');
  });

  it('justifyContent enum mirrors getJustifyOptions() exactly', () => {
    const ui = getJustifyOptions().map((o) => o.value);
    expect(LAYOUT_JUSTIFY_VALUES).toEqual(ui);
  });

  it('direction/wrap/display enums are the LayoutTool toggle values', () => {
    expect(LAYOUT_DIRECTION_VALUES).toEqual(['row', 'row-reverse', 'column', 'column-reverse']);
    expect(LAYOUT_WRAP_VALUES).toEqual(['nowrap', 'wrap']);
    expect(LAYOUT_DISPLAY_VALUES).toEqual(['flex', 'block', 'grid', 'none']);
  });

  it('position modes are the Position panel types', () => {
    expect(POSITION_MODE_VALUES).toEqual(['relative', 'absolute', 'fixed', 'sticky']);
  });

  it('textAlign values are the text-align options', () => {
    expect(TEXT_ALIGN_VALUES).toEqual(['left', 'center', 'right', 'justify']);
  });

  it('px values are the builder dialect (<n>px strings)', () => {
    expect('24px').toMatch(PX_VALUE_RE);
    expect('0px').toMatch(PX_VALUE_RE);
    expect('-8.5px').toMatch(PX_VALUE_RE);
    expect('24').not.toMatch(PX_VALUE_RE);
    expect('24%').not.toMatch(PX_VALUE_RE);
    expect('1.5rem').not.toMatch(PX_VALUE_RE);
  });
});

// ─── PARITY: mutation payloads = the panel writes ──────────────────────────

describe('action layer — mutation payloads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('set_layout queues one updateStyles per provided field (editor per-control writes)', async () => {
    const ctx = makeCtx();
    const result = await setLayoutTool.execute(
      { node_id: 'hero', display: 'flex', alignItems: 'center', gap: '24px' },
      ctx,
    );
    expect(ctx.ensureCheckpoint).toHaveBeenCalledTimes(1);
    expect(queueMutation).toHaveBeenCalledTimes(3);
    expect(queueMutation).toHaveBeenNthCalledWith(1, {
      type: 'updateStyles', nodeId: 'hero', styles: { display: 'flex' },
    }, expect.anything());
    expect(queueMutation).toHaveBeenNthCalledWith(2, {
      type: 'updateStyles', nodeId: 'hero', styles: { alignItems: 'center' },
    }, expect.anything());
    expect(queueMutation).toHaveBeenNthCalledWith(3, {
      type: 'updateStyles', nodeId: 'hero', styles: { gap: '24px' },
    }, expect.anything());
    expect(flushNow).toHaveBeenCalledTimes(1);
    expect(JSON.parse((result.content[0] as any).text)).toEqual({ node_id: 'hero', applied: 3 });
    expect(result.isError).toBeUndefined();
  });

  it('set_layout queues a single updateStyles with "" removal values passed through', async () => {
    const ctx = makeCtx();
    await setLayoutTool.execute({ node_id: 'hero', gap: '' }, ctx);
    expect(queueMutation).toHaveBeenCalledTimes(1);
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'updateStyles', nodeId: 'hero', styles: { gap: '' },
    }, expect.anything());
  });

  it('set_layout fails without any field (no mutation)', async () => {
    const ctx = makeCtx();
    const result = await setLayoutTool.execute({ node_id: 'hero' }, ctx);
    expect(result.isError).toBe(true);
    expect(ctx.ensureCheckpoint).not.toHaveBeenCalled();
    expect(queueMutation).not.toHaveBeenCalled();
  });

  it('set_size queues one updateStyles with all provided px fields', async () => {
    const ctx = makeCtx();
    const result = await setSizeTool.execute({ node_id: 'card', width: '640px', height: '480px', maxWidth: '800px' }, ctx);
    expect(ctx.ensureCheckpoint).toHaveBeenCalledTimes(1);
    expect(queueMutation).toHaveBeenCalledTimes(1);
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'updateStyles', nodeId: 'card', styles: { width: '640px', height: '480px', maxWidth: '800px' },
    }, expect.anything());
    expect(flushNow).toHaveBeenCalledTimes(1);
    expect(JSON.parse((result.content[0] as any).text)).toEqual({ node_id: 'card', applied: 3 });
  });

  it('set_size fails with no fields', async () => {
    const ctx = makeCtx();
    const result = await setSizeTool.execute({ node_id: 'card' }, ctx);
    expect(result.isError).toBe(true);
    expect(queueMutation).not.toHaveBeenCalled();
  });

  it('set_position queues updateStyles (mode + insets) and updateHtmlAttrs for pinned: true', async () => {
    const ctx = makeCtx();
    const result = await setPositionTool.execute(
      { node_id: 'badge', mode: 'absolute', left: '12px', top: '0px', pinned: true },
      ctx,
    );
    expect(ctx.ensureCheckpoint).toHaveBeenCalledTimes(1);
    expect(queueMutation).toHaveBeenCalledTimes(2);
    expect(queueMutation).toHaveBeenNthCalledWith(1, {
      type: 'updateStyles', nodeId: 'badge', styles: { position: 'absolute', left: '12px', top: '0px' },
    }, expect.anything());
    // The Position panel's pin lock (PinControl.lockNodePinning) writes data-pinned.
    expect(queueMutation).toHaveBeenNthCalledWith(2, {
      type: 'updateHtmlAttrs', nodeId: 'badge', attrs: { 'data-pinned': 'true' },
    }, expect.anything());
    expect(flushNow).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeUndefined();
  });

  it('set_position pinned: false writes data-pinned "" (removes the lock)', async () => {
    const ctx = makeCtx();
    await setPositionTool.execute({ node_id: 'badge', pinned: false }, ctx);
    expect(queueMutation).toHaveBeenCalledTimes(1);
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'updateHtmlAttrs', nodeId: 'badge', attrs: { 'data-pinned': '' },
    }, expect.anything());
  });

  it('set_position with "" inset removes that pin', async () => {
    const ctx = makeCtx();
    await setPositionTool.execute({ node_id: 'badge', left: '' }, ctx);
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'updateStyles', nodeId: 'badge', styles: { left: '' },
    }, expect.anything());
  });

  it('set_position fails with no fields', async () => {
    const ctx = makeCtx();
    const result = await setPositionTool.execute({ node_id: 'badge' }, ctx);
    expect(result.isError).toBe(true);
    expect(queueMutation).not.toHaveBeenCalled();
  });

  it('set_typography queues one updateStyles with all provided fields (fontWeight stringified)', async () => {
    const ctx = makeCtx();
    const result = await setTypographyTool.execute(
      {
        node_id: 't', fontSize: '32px', fontWeight: 700, lineHeight: '1.5',
        letterSpacing: '0.5px', fontFamily: 'var(--typo-heading)', textAlign: 'center', color: '#6366f1',
      },
      ctx,
    );
    expect(ctx.ensureCheckpoint).toHaveBeenCalledTimes(1);
    expect(queueMutation).toHaveBeenCalledTimes(1);
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'updateStyles', nodeId: 't',
      styles: {
        fontSize: '32px', fontWeight: '700', lineHeight: '1.5', letterSpacing: '0.5px',
        fontFamily: 'var(--typo-heading)', textAlign: 'center', color: '#6366f1',
      },
    }, expect.anything());
    expect(flushNow).toHaveBeenCalledTimes(1);
    expect(JSON.parse((result.content[0] as any).text)).toEqual({ node_id: 't', applied: 7 });
  });

  it('set_typography passes fontWeight string keywords through', async () => {
    const ctx = makeCtx();
    await setTypographyTool.execute({ node_id: 't', fontWeight: 'bold' }, ctx);
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'updateStyles', nodeId: 't', styles: { fontWeight: 'bold' },
    }, expect.anything());
  });

  it('set_typography lineHeight is the oracle\'s dialect: unitless ratio or normal — px is REFUSED', async () => {
    // It used to accept px "per the M12 spec"; the oracle's LINE_HEIGHT_FORMAT
    // rejects px, so the tool was teaching the one value that guarantees a bounce.
    expect(parseInput(setTypographyTool, { node_id: 't', lineHeight: '24px' }).success).toBe(false);
    expect(parseInput(setTypographyTool, { node_id: 't', lineHeight: '1.5' }).success).toBe(true);
    expect(parseInput(setTypographyTool, { node_id: 't', lineHeight: 'normal' }).success).toBe(true);
  });

  it('set_typography fails with no fields', async () => {
    const ctx = makeCtx();
    const result = await setTypographyTool.execute({ node_id: 't' }, ctx);
    expect(result.isError).toBe(true);
    expect(queueMutation).not.toHaveBeenCalled();
  });
});

// ─── ANTI-PERMISSIVITY ─────────────────────────────────────────────────────

describe('action layer — anti-permissivity', () => {
  it('set_layout rejects alignItems stretch and baseline (not in the Align control)', () => {
    expect(parseInput(setLayoutTool, { node_id: 'x', alignItems: 'stretch' }).success).toBe(false);
    expect(parseInput(setLayoutTool, { node_id: 'x', alignItems: 'baseline' }).success).toBe(false);
    expect(parseInput(setLayoutTool, { node_id: 'x', alignItems: 'flex-start' }).success).toBe(true);
  });

  it('set_layout rejects unknown values on every enum field', () => {
    expect(parseInput(setLayoutTool, { node_id: 'x', display: 'inline' }).success).toBe(false);
    expect(parseInput(setLayoutTool, { node_id: 'x', flexDirection: 'diagonal' }).success).toBe(false);
    expect(parseInput(setLayoutTool, { node_id: 'x', justifyContent: 'space-between-x' }).success).toBe(false);
    expect(parseInput(setLayoutTool, { node_id: 'x', flexWrap: 'wrap-reverse' }).success).toBe(false);
  });

  it('set_layout rejects gap without px', () => {
    expect(parseInput(setLayoutTool, { node_id: 'x', gap: '12' }).success).toBe(false);
    expect(parseInput(setLayoutTool, { node_id: 'x', gap: '12%' }).success).toBe(false);
    expect(parseInput(setLayoutTool, { node_id: 'x', gap: '1rem' }).success).toBe(false);
    expect(parseInput(setLayoutTool, { node_id: 'x', gap: '12px' }).success).toBe(true);
  });

  it('set_size rejects % and non-px units on every field', () => {
    for (const key of ['width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight'] as const) {
      expect(parseInput(setSizeTool, { node_id: 'x', [key]: '50%' }).success, `${key} 50%`).toBe(false);
      expect(parseInput(setSizeTool, { node_id: 'x', [key]: '100vw' }).success, `${key} vw`).toBe(false);
      expect(parseInput(setSizeTool, { node_id: 'x', [key]: 'auto' }).success, `${key} auto`).toBe(false);
      expect(parseInput(setSizeTool, { node_id: 'x', [key]: '640px' }).success, `${key} px`).toBe(true);
    }
  });

  it('set_position rejects % insets (same constraint as the oracle PIN rules)', () => {
    for (const key of ['left', 'top', 'right', 'bottom'] as const) {
      expect(parseInput(setPositionTool, { node_id: 'x', [key]: '50%' }).success, `${key} %`).toBe(false);
      expect(parseInput(setPositionTool, { node_id: 'x', [key]: '10em' }).success, `${key} em`).toBe(false);
      expect(parseInput(setPositionTool, { node_id: 'x', [key]: '24px' }).success, `${key} px`).toBe(true);
    }
  });

  it('set_position rejects unknown modes', () => {
    expect(parseInput(setPositionTool, { node_id: 'x', mode: 'absolute!' }).success).toBe(false);
    expect(parseInput(setPositionTool, { node_id: 'x', mode: 'static' }).success).toBe(false);
  });

  it('set_typography accepts fontWeight "bold" / "normal" / number but rejects fontSize "bold"', () => {
    expect(parseInput(setTypographyTool, { node_id: 'x', fontWeight: 'bold' }).success).toBe(true);
    expect(parseInput(setTypographyTool, { node_id: 'x', fontWeight: 'normal' }).success).toBe(true);
    expect(parseInput(setTypographyTool, { node_id: 'x', fontWeight: 700 }).success).toBe(true);
    expect(parseInput(setTypographyTool, { node_id: 'x', fontWeight: 'heavy' }).success).toBe(false);
    expect(parseInput(setTypographyTool, { node_id: 'x', fontSize: 'bold' }).success).toBe(false);
    expect(parseInput(setTypographyTool, { node_id: 'x', fontSize: 'boldpx' }).success).toBe(false);
  });

  it('set_typography rejects non-px units per property and bad color', () => {
    expect(parseInput(setTypographyTool, { node_id: 'x', fontSize: '2em' }).success).toBe(false);
    expect(parseInput(setTypographyTool, { node_id: 'x', fontSize: '1.5rem' }).success).toBe(false);
    expect(parseInput(setTypographyTool, { node_id: 'x', letterSpacing: '0.1em' }).success).toBe(false);
    expect(parseInput(setTypographyTool, { node_id: 'x', color: 'red' }).success).toBe(false);
    expect(parseInput(setTypographyTool, { node_id: 'x', color: '#fff' }).success).toBe(false);
    expect(parseInput(setTypographyTool, { node_id: 'x', color: '#6366f1' }).success).toBe(true);
    expect(parseInput(setTypographyTool, { node_id: 'x', textAlign: 'justify' }).success).toBe(true);
    expect(parseInput(setTypographyTool, { node_id: 'x', textAlign: 'start' }).success).toBe(false);
  });

  it('set_component_prop still rejects undeclared props — with and without variant', async () => {
    vi.mocked(buildComponentRegistry).mockReturnValue(
      new Map([[
        'Hero',
        {
          name: 'Hero', filePath: 'components/Hero.tsx',
          props: [{ name: 'title', defaultValue: 'Build', varType: 'text' }],
          contentHash: 'h1', controlsMeta: null,
        },
      ]]) as never,
    );
    const ctx = makeCtx();
    const plain = await setComponentPropTool.execute(
      { node_id: 'n1', component_name: 'Hero', prop: 'banana', value: 'x' }, ctx,
    );
    expect(plain.isError).toBe(true);
    vi.clearAllMocks();
    const ctxV = makeCtx();
    const variant = await setComponentPropTool.execute(
      { node_id: 'n1', component_name: 'Hero', prop: 'banana', value: 'x', variant: 'variant-1' }, ctxV,
    );
    expect(variant.isError).toBe(true);
    expect(queueMutation).not.toHaveBeenCalled();
  });
});

// ─── set_component_prop variant axis ───────────────────────────────────────

describe('set_component_prop — variant axis', () => {
  const HERO_PROPS = {
    name: 'Hero',
    filePath: 'components/Hero.tsx',
    props: [
      { name: 'title', defaultValue: 'Build', varType: 'text', description: 'Main heading' },
      { name: 'variant', defaultValue: 'primary', varType: 'option' },
      { name: 'count', defaultValue: null, varType: 'number' },
      { name: 'eyebrow', defaultValue: null },
    ],
    contentHash: 'h1',
    controlsMeta: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(buildComponentRegistry).mockReturnValue(new Map([['Hero', HERO_PROPS]]) as never);
    vi.mocked(getNodesSnapshot).mockReturnValue(new Map<string, CanvasNode>([
      ['n1', { id: 'n1', type: 'Hero', attrs: { title: 'Build' }, styles: {} } as unknown as CanvasNode],
    ]));
  });

  it('with variant queues setVariantAttr (editor Input-tool variant axis) preserving the base value', async () => {
    const ctx = makeCtx();
    const result = await setComponentPropTool.execute(
      { node_id: 'n1', component_name: 'Hero', prop: 'title', value: 'Ship', variant: 'variant-1' },
      ctx,
    );
    expect(ctx.ensureCheckpoint).toHaveBeenCalledTimes(1);
    expect(queueMutation).toHaveBeenCalledTimes(1);
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'setVariantAttr',
      nodeId: 'n1',
      variant: 'variant-1',
      attr: 'title',
      value: 'Ship',
      baseValue: 'Build',
    }, expect.anything());
    expect(flushNow).toHaveBeenCalledTimes(1);
    const data = JSON.parse((result.content[0] as any).text);
    expect(data).toMatchObject({ node_id: 'n1', prop: 'title', variant: 'variant-1', removed: false });
    expect(result.isError).toBeUndefined();
  });

  it('with variant + "" value removes only that variant override (base untouched)', async () => {
    const ctx = makeCtx();
    const result = await setComponentPropTool.execute(
      { node_id: 'n1', component_name: 'Hero', prop: 'title', value: '', variant: 'variant-1' },
      ctx,
    );
    expect(queueMutation).toHaveBeenCalledTimes(1);
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'setVariantAttr', nodeId: 'n1', variant: 'variant-1', attr: 'title', value: '', baseValue: 'Build',
    }, expect.anything());
    expect(JSON.parse((result.content[0] as any).text).removed).toBe(true);
  });

  it('variant "default" and no variant both write the base via updateHtmlAttrs (unchanged)', async () => {
    const ctx = makeCtx();
    await setComponentPropTool.execute(
      { node_id: 'n1', component_name: 'Hero', prop: 'title', value: 'Ship', variant: 'default' },
      ctx,
    );
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'updateHtmlAttrs', nodeId: 'n1', attrs: { title: 'Ship' },
    }, expect.anything());

    vi.clearAllMocks();
    await setComponentPropTool.execute(
      { node_id: 'n1', component_name: 'Hero', prop: 'title', value: 'Ship' }, ctx,
    );
    expect(queueMutation).toHaveBeenCalledWith({
      type: 'updateHtmlAttrs', nodeId: 'n1', attrs: { title: 'Ship' },
    }, expect.anything());
  });
});

// ─── REGISTRATION ──────────────────────────────────────────────────────────

describe('action layer — registration', () => {
  it('ACTION_TOOLS exports the four primitives with category semantic', () => {
    expect(ACTION_TOOLS.map((t) => t.name)).toEqual([
      'set_layout',
      'set_size',
      'set_position',
      'set_typography',
    ]);
    for (const tool of ACTION_TOOLS) {
      expect(tool.category).toBe('semantic');
      expect(typeof tool.execute).toBe('function');
      expect(typeof tool.description).toBe('string');
      expect(tool.inputSchema).toBeTruthy();
    }
  });

  it('RICH_ACTION_TOOLS exports the ten rich primitives with category semantic (P7 adds create_component)', () => {
    expect(RICH_ACTION_TOOLS.map((t) => t.name)).toEqual([
      'set_motion_preset',
      'create_overlay',
      'set_variant',
      'create_variant',
      'extract_component',
      'create_component',
      'bind_cms_list',
      'bind_cms_field',
      'set_form',
      'create_page',
    ]);
    for (const tool of RICH_ACTION_TOOLS) {
      expect(tool.category).toBe('semantic');
      expect(typeof tool.execute).toBe('function');
      expect(typeof tool.description).toBe('string');
      expect(tool.inputSchema).toBeTruthy();
    }
  });

  it('all four tools are registered in ALL_TOOLS', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    for (const name of ['set_layout', 'set_size', 'set_position', 'set_typography']) {
      expect(names).toContain(name);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it('all nine rich tools are registered in ALL_TOOLS, unique', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    for (const name of ['set_motion_preset', 'create_overlay', 'set_variant', 'create_variant', 'extract_component', 'bind_cms_list', 'bind_cms_field', 'set_form', 'create_page']) {
      expect(names).toContain(name);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it('toProviderTools and toHostToolDescriptors expose the same names (provider ≡ host)', () => {
    const providerNames = toProviderTools(ALL_TOOLS).map((t) => t.name);
    const hostNames = toHostToolDescriptors(ALL_TOOLS).map((t) => t.name);
    expect(providerNames).toEqual(hostNames);
    for (const name of ['set_layout', 'set_size', 'set_position', 'set_typography', 'set_component_prop', 'set_motion_preset', 'create_overlay', 'set_variant', 'create_variant', 'extract_component', 'bind_cms_list', 'bind_cms_field', 'set_form', 'create_page']) {
      expect(providerNames).toContain(name);
      expect(hostNames).toContain(name);
    }
  });

  it('every ACTION_TOOL serializes to a provider schema without throwing', () => {
    for (const tool of [...ACTION_TOOLS, ...RICH_ACTION_TOOLS]) {
      const [provider] = toProviderTools([tool]);
      expect(provider.name).toBe(tool.name);
      const properties = provider.input_schema.properties as Record<string, unknown>;
      if (tool.name === 'create_page') {
        expect(properties.name ?? properties.dir).toBeTruthy();
      } else if (tool.name === 'create_variant') {
        // Component-scoped like create_page is page-scoped: anchored by
        // component name, no node_id (mirrors the create_page exception).
        expect(properties.component).toBeTruthy();
      } else if (tool.name === 'create_component') {
        // Authoring scoped by master name (P7 Ib-3): no node_id, no
        // component — the declaration carries name/props/from/layout.
        expect(properties.name).toBeTruthy();
      } else {
        expect(properties.node_id).toBeTruthy();
      }
    }
  });
});

// ─── Branch routing (P8) ─────────────────────────────────────────────────────

describe('action layer — branch routing (P8)', () => {
  const BRANCH = 'agent-br';
  const FILE = 'app/page.client.tsx';

  function branchCtx(): ToolContext {
    return {
      ensureCheckpoint: vi.fn(),
      vpWidth: 1440,
      signal: new AbortController().signal,
      workspace: { branchId: BRANCH, filePath: FILE },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    expect(projectFS.createBranch(BRANCH)).toBeNull();
  });

  afterEach(() => {
    resetProjectFS();
  });

  it('branched set_size scopes the mutation to the branch map (file + branchId + author)', async () => {
    const ctx = branchCtx();
    const result = await setSizeTool.execute({ node_id: 'card', width: '640px' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(queueMutation).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'updateStyles', nodeId: 'card' }),
      expect.objectContaining({ author: 'agent', file: FILE, branchId: BRANCH }),
    );
    expect(flushNow).toHaveBeenCalledWith({ branchId: BRANCH });
  });

  it('unbranched runs keep the exact legacy routing (main scope, bare flush)', async () => {
    const ctx = makeCtx();
    await setSizeTool.execute({ node_id: 'card', width: '640px' }, ctx);
    expect(queueMutation).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'updateStyles', nodeId: 'card' }),
      expect.objectContaining({ author: 'agent', branchId: 'main' }),
    );
    expect(flushNow).toHaveBeenCalledWith();
  });
});