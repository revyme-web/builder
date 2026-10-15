// set-component-prop.test.ts — the agent's instance-prop write against REAL
// source: in-place replace whatever the existing form, typed values, explicit
// expressions, honest read-back, and variant scoping only where it can exist.
//
// Agent report 2026-10-15: "set_component_prop can't set JS expressions (they
// become a literal string) and sometimes duplicates the attribute."

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDefaultStore } from 'jotai';
import { activeFilePathAtom } from '@/code/project/active-file-store';
import type { ToolContext } from '@/ai/agent';
import { projectFS, resetProjectFS } from '@/code/project/project-fs';
import { setComponentPropTool } from './semantic-structure';
import { resolveInstancePropWrite } from './instance-prop-write';

const HERO = `'use client';
/** @propMeta {"count":{"type":"number"},"open":{"type":"toggle"},"title":"Heading"} */
export default function Hero({ style, title = 'Build', count = 3, open = false, items = [] }) {
  return <div data-id="hero-root" style={{ position: 'relative', ...style }}>{title}</div>;
}`;

const page = (heroAttrs: string) => `'use client';
import React from 'react';
import Hero from '@/components/Hero';
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative' }}>
      <Hero data-id="h1" ${heroAttrs} style={{ position: 'relative' }} />
    </div>
  );
}`;

const ctx = (): ToolContext => ({ ensureCheckpoint: vi.fn(), vpWidth: 1440, signal: new AbortController().signal });

function load(heroAttrs: string) {
  resetProjectFS();
  projectFS.loadSnapshot(new Map([
    ['app/page.client.tsx', page(heroAttrs)],
    ['components/Hero.tsx', HERO],
  ]));
}

async function run(args: Record<string, unknown>) {
  const r = await setComponentPropTool.execute({ node_id: 'h1', component_name: 'Hero', ...args }, ctx());
  return { isError: !!r.isError, data: JSON.parse((r.content[0] as { text: string }).text) };
}

const heroTag = () => /<Hero[\s\S]*?\/>/.exec(projectFS.readFile('app/page.client.tsx')!)![0];

describe('set_component_prop', () => {
  beforeEach(() => load('title="Old"'));

  it('a number prop is written as a number, not a string', async () => {
    const r = await run({ prop: 'count', value: '60' });
    expect(r.isError).toBe(false);
    expect(r.data.written).toBe('count={60}');
    expect(heroTag()).toContain('count={60}');
  });

  it('a toggle is written as a boolean (the string "false" is truthy)', async () => {
    await run({ prop: 'open', value: 'false' });
    expect(heroTag()).toContain('open={false}');
  });

  it('a wrong-typed literal is refused with the reason, nothing written', async () => {
    const before = projectFS.readFile('app/page.client.tsx');
    const r = await run({ prop: 'count', value: 'lots' });
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatch(/NUMBER prop/);
    expect(projectFS.readFile('app/page.client.tsx')).toBe(before);
  });

  it('expression: true writes JavaScript, parse-checked', async () => {
    const r = await run({ prop: 'items', value: "[{ label: 'A' }, { label: 'B' }]", expression: true });
    expect(r.data.written).toBe("items={[{ label: 'A' }, { label: 'B' }]}");
    const bad = await run({ prop: 'items', value: '[{ label: ', expression: true });
    expect(bad.isError).toBe(true);
    expect(bad.data.error).toMatch(/does not parse/);
  });

  it('replaces an existing EXPRESSION in place — no duplicate (the reported bug)', async () => {
    load('count={3} items={[{ a: { b: 1 } }]}');
    await run({ prop: 'count', value: '7' });
    await run({ prop: 'items', value: '[]', expression: true });
    const tag = heroTag();
    expect(tag.match(/count=/g)).toHaveLength(1);
    expect(tag.match(/items=/g)).toHaveLength(1);
    expect(tag).toContain('count={7}');
    expect(tag).toContain('items={[]}');
  });

  it('heals a duplicate already in the source', async () => {
    load('title="A" title={b}');
    await run({ prop: 'title', value: 'C' });
    expect(heroTag().match(/title=/g)).toHaveLength(1);
    expect(heroTag()).toContain('title="C"');
  });

  it('"" removes an expression prop (used to be a silent no-op)', async () => {
    load('items={[1, 2]}');
    const r = await run({ prop: 'items', value: '' });
    expect(r.data.removed).toBe(true);
    expect(heroTag()).not.toContain('items');
  });

  it('a string value with both quote kinds stays valid JSX', async () => {
    await run({ prop: 'title', value: `It's "great"` });
    expect(heroTag()).toContain(`title={"It's \\"great\\""}`);
  });

  it('variant on a PAGE instance is refused (it used to write an undefined initialVariant into the page)', async () => {
    const before = projectFS.readFile('app/page.client.tsx');
    const r = await run({ prop: 'title', value: 'Hover', variant: 'hover' });
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatch(/show_variant/);
    expect(projectFS.readFile('app/page.client.tsx')).toBe(before);
  });

  it('an unknown node is refused, never written to the first <Hero> in the file', async () => {
    const before = projectFS.readFile('app/page.client.tsx');
    const r = await setComponentPropTool.execute({ node_id: 'ghost', component_name: 'Hero', prop: 'title', value: 'X' }, ctx());
    expect(r.isError).toBe(true);
    expect(projectFS.readFile('app/page.client.tsx')).toBe(before);
  });
});

describe('set_component_prop inside a component master (per-variant values)', () => {
  const CARD = `'use client';
import Hero from '@/components/Hero';
const variantConfig = [{ name: 'default', isPrimary: true }, { name: 'hover' }];
export default function Card({ style, initialVariant = 'default' }) {
  return (
    <div data-id="card-root" style={{ position: 'relative', ...style }}>
      <Hero data-id="h2" title="Hi" count={3} style={{ position: 'relative' }} />
    </div>
  );
}`;

  beforeEach(() => {
    resetProjectFS();
    projectFS.loadSnapshot(new Map([['components/Hero.tsx', HERO], ['components/Card.tsx', CARD], ['app/page.client.tsx', page('')]]));
    getDefaultStore().set(activeFilePathAtom, 'components/Card.tsx');
  });
  afterEach(() => getDefaultStore().set(activeFilePathAtom, 'app/page.client.tsx'));

  const card = () => projectFS.readFile('components/Card.tsx')!;

  it('scopes a value to one variant, keeps the base, and removes just that branch', async () => {
    const r = await setComponentPropTool.execute({ node_id: 'h2', component_name: 'Hero', prop: 'title', value: "Let's go", variant: 'hover' }, ctx());
    expect(r.isError).toBeFalsy();
    expect(card()).toContain(`title={initialVariant === 'hover' ? "Let's go" : 'Hi'}`);
    await setComponentPropTool.execute({ node_id: 'h2', component_name: 'Hero', prop: 'title', value: '', variant: 'hover' }, ctx());
    expect(card()).toContain('title="Hi"');
    expect(card().match(/title=/g)).toHaveLength(1);
  });

  it('a number keeps its type inside the ternary', async () => {
    await setComponentPropTool.execute({ node_id: 'h2', component_name: 'Hero', prop: 'count', value: '9', variant: 'hover' }, ctx());
    expect(card()).toContain("count={initialVariant === 'hover' ? 9 : 3}");
  });

  it('an unknown variant names the real ones', async () => {
    const r = await setComponentPropTool.execute({ node_id: 'h2', component_name: 'Hero', prop: 'title', value: 'x', variant: 'pressed' }, ctx());
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toMatch(/default, hover/);
  });
});

describe('resolveInstancePropWrite', () => {
  it('formatted text becomes an escaped JS string; untyped stays a string', () => {
    const info = { name: 'X', filePath: 'components/X.tsx', contentHash: '', controlsMeta: null, props: [{ name: 'body', defaultValue: '', varType: 'formattedText' }, { name: 'label', defaultValue: '' }] };
    expect(resolveInstancePropWrite({ prop: 'body', value: '<b>Hi</b>', info })).toEqual({ ok: true, write: { value: '"<b>Hi</b>"', expression: true } });
    expect(resolveInstancePropWrite({ prop: 'label', value: '60', info })).toEqual({ ok: true, write: { value: '60', expression: false } });
  });

  it('link booleans (New Tab) are booleans', () => {
    expect(resolveInstancePropWrite({ prop: 'newTab', value: 'TRUE', linkKind: 'newTab' })).toEqual({ ok: true, write: { value: 'true', expression: true } });
  });

  it('a transition JSON object becomes the canonical object expression', () => {
    const info = { name: 'X', filePath: 'components/X.tsx', contentHash: '', controlsMeta: null, props: [{ name: 't', defaultValue: '', varType: 'transition' }] };
    const r = resolveInstancePropWrite({ prop: 't', value: '{"type":"spring","duration":0.5}', info });
    expect(r).toEqual({ ok: true, write: { value: "{ type: 'spring', duration: 0.5 }", expression: true } });
  });
});
