// create-component-gen.test.ts — P7 (ii): canonical emitter, proofs.

import { describe, it, expect } from 'vitest';
import { buildCreatedMaster, type CreateComponentSpec } from './create-component-gen';
import { checkFile } from '@/code/oracle/check-file';
import { parsePropMeta } from '@/code/components/prop-meta';

const LAYOUT_SPEC: CreateComponentSpec = {
  name: 'PricingCard',
  props: [
    { name: 'title', type: 'string', default: 'Starter' },
    { name: 'price', type: 'string', default: '$19' },
  ],
  variants: [{ name: 'open' }],
  layout: [
    {
      tag: 'div',
      dataId: 'card',
      style: { position: 'relative', display: 'flex', flexDirection: 'column' },
      children: [
        { tag: 'p', text: '{title}', style: { position: 'relative', fontSize: '20px' } },
        { tag: 'p', text: '{price}', style: { position: 'relative' } },
      ],
    },
  ],
};

const PAGE_WITH_CARD = `'use client';
import React from 'react';
export default function Page() {
  return (
    <div data-id="root" style={{ position: 'relative' }}>
      <div data-id="plan" style={{ position: 'relative' }}>
        <p data-id="plan-title" style={{ position: 'relative' }}>Pro</p>
        <p data-id="plan-price" style={{ position: 'relative' }}>$49</p>
      </div>
    </div>
  );
}`;

describe('buildCreatedMaster — layout mode', () => {
  it('emits the oracle-canonical master shape', () => {
    const r = buildCreatedMaster(LAYOUT_SPEC);
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.masterCode).toContain(`"use client";`);
    expect(r.masterCode).toContain('@revyme/runtime');
    expect(r.masterCode).toContain('/** @name "PricingCard" */');
    expect(r.masterCode).toContain('withResponsiveProps(PricingCard)');
    expect(r.masterCode).toContain(`initialVariant = 'default'`);
    expect(r.masterCode).toContain('...style');
    expect(r.masterCode).toContain(`title = "Starter"`);
    expect(r.masterCode).toContain('title?: string');
    expect(r.masterCode).toContain(`name: 'default'`);
    expect(r.masterCode).toContain(`name: 'open'`);
    expect(r.props.map((p) => p.name)).toEqual(['title', 'price']);
    expect(r.dataIds).toContain('pricing-card-root');
    expect(r.dataIds).toContain('card');
  });

  it('types every declared prop in @propMeta (Variables panel type, Localization plainText listing)', () => {
    const r = buildCreatedMaster(LAYOUT_SPEC);
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    const meta = parsePropMeta(r.masterCode);
    expect(meta.title?.type).toBe('plainText');
    expect(meta.price?.type).toBe(LAYOUT_SPEC.props.find((p) => p.name === 'price')!.type === 'number' ? 'number' : 'plainText');
    expect(checkFile(r.masterCode, { kind: 'component', path: 'components/PricingCard.tsx' })).toEqual([]);
  });

  it('binds {prop} in text and whole style values', () => {
    const r = buildCreatedMaster(LAYOUT_SPEC);
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.masterCode).toContain('{title}');
    expect(r.masterCode).toContain('{price}');
  });

  it('refuses mixed literal+binding text (computed text is uneditable)', () => {
    const r = buildCreatedMaster({
      name: 'Bad',
      props: [{ name: 'price', type: 'string', default: '$9' }],
      layout: [{ tag: 'p', text: 'Only {price}/mo', style: { position: 'relative' } }],
    });
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error).toContain('Mixed text');
  });

  it('emitted master passes checkFile kind component with zero violations (Ib-3 sortie garantie)', () => {
    const r = buildCreatedMaster(LAYOUT_SPEC);
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    const vs = checkFile(r.masterCode, { kind: 'component', path: 'components/PricingCard.tsx' });
    expect(vs.map((v) => v.code)).toEqual([]);
  });

  it('motion tags add the framer-motion import', () => {
    const r = buildCreatedMaster({
      name: 'FadeBox',
      props: [],
      layout: [{ tag: 'motion.div', text: 'Hi', style: { position: 'relative' } }],
    });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.masterCode).toContain(`from 'framer-motion'`);
    const vs = checkFile(r.masterCode, { kind: 'component', path: 'components/FadeBox.tsx' });
    expect(vs.map((v) => v.code)).toEqual([]);
  });
});

describe('buildCreatedMaster — from mode', () => {
  it('binds source texts to declared props in document order', () => {
    const r = buildCreatedMaster(
      {
        name: 'PlanCard',
        props: [
          { name: 'title', type: 'string', default: 'T' },
          { name: 'price', type: 'string', default: 'P' },
        ],
        from: 'plan',
      },
      { sourceCode: PAGE_WITH_CARD },
    );
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.masterCode).toContain('{title}');
    expect(r.masterCode).toContain('{price}');
    expect(r.masterCode).not.toContain('>Pro<');
    const vs = checkFile(r.masterCode, { kind: 'component', path: 'components/PlanCard.tsx' });
    expect(vs.map((v) => v.code)).toEqual([]);
  });

  it('refuses on text/prop count mismatch', () => {
    const r = buildCreatedMaster(
      { name: 'PlanCard', props: [{ name: 'title', type: 'string', default: 'T' }], from: 'plan' },
      { sourceCode: PAGE_WITH_CARD },
    );
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error).toContain('2 text leaves but 1 props');
  });

  it('refuses missing node and component instances', () => {
    expect('error' in buildCreatedMaster({ name: 'X', props: [], from: 'nope' }, { sourceCode: PAGE_WITH_CARD })).toBe(true);
  });
});

describe('buildCreatedMaster — pedagogical refusals (never silent)', () => {
  const base: CreateComponentSpec = { name: 'Ok', props: [], layout: [{ tag: 'div', style: { position: 'relative' } }] };
  it('refuses bad names', () => {
    expect('error' in buildCreatedMaster({ ...base, name: 'nope' })).toBe(true);
  });
  it('refuses neither/both sources', () => {
    expect('error' in buildCreatedMaster({ name: 'Ok', props: [] })).toBe(true);
    expect(
      'error' in
        buildCreatedMaster({ name: 'Ok', props: [], from: 'x', layout: [{ tag: 'div', style: { position: 'relative' } }] }),
    ).toBe(true);
  });
  it('refuses bad/reserved/duplicate props and type mismatches', () => {
    expect('error' in buildCreatedMaster({ ...base, props: [{ name: '9bad', type: 'string', default: 'x' }] })).toBe(true);
    expect('error' in buildCreatedMaster({ ...base, props: [{ name: 'style', type: 'string', default: 'x' }] })).toBe(true);
    expect(
      'error' in
        buildCreatedMaster({
          ...base,
          props: [
            { name: 'a', type: 'string', default: 'x' },
            { name: 'a', type: 'string', default: 'y' },
          ],
        }),
    ).toBe(true);
    expect('error' in buildCreatedMaster({ ...base, props: [{ name: 'n', type: 'number', default: 'x' }] })).toBe(true);
    expect('error' in buildCreatedMaster({ ...base, props: [{ name: 't', type: 'string', default: 4 }] })).toBe(true);
  });
  it('refuses unknown {prop}, bad tags, nested instances, embedded style exprs', () => {
    expect(
      'error' in buildCreatedMaster({ name: 'Ok', props: [], layout: [{ tag: 'p', text: '{ghost}', style: { position: 'relative' } }] }),
    ).toBe(true);
    expect('error' in buildCreatedMaster({ name: 'Ok', props: [], layout: [{ tag: 'Hero', style: { position: 'relative' } }] })).toBe(true);
    expect(
      'error' in
        buildCreatedMaster({
          name: 'Ok',
          props: [{ name: 'c', type: 'color', default: '#fff' }],
          layout: [{ tag: 'div', style: { position: 'relative', color: '1px solid {c}' } }],
        }),
    ).toBe(true);
  });
  it('refuses declared-but-never-bound props (B1: compiler, not just gate)', () => {
    const r = buildCreatedMaster({
      name: 'Card',
      props: [
        { name: 'title', type: 'string', default: 'T' },
        { name: 'ghost', type: 'string', default: 'G' },
      ],
      layout: [{ tag: 'p', text: '{title}', style: { position: 'relative' } }],
    });
    expect('error' in r).toBe(true);
    if (!('error' in r)) return;
    expect(r.error).toContain('"ghost"');
    expect(r.error).toContain('never bound');
  });
  it('refuses bad variants', () => {
    expect('error' in buildCreatedMaster({ ...base, variants: [{ name: 'Default' }] })).toBe(true);
    expect('error' in buildCreatedMaster({ ...base, variants: [{ name: 'default' }] })).toBe(true);
  });
});

describe('created master — panel operability (D3 mechanical pre-check)', () => {
  it('set_variant write path accepts the master and it stays gate-clean', async () => {
    const { updateVariantStyleInCode } = await import('./generator-styles');
    const r = buildCreatedMaster({
      name: 'SwitchCard',
      props: [{ name: 'title', type: 'string', default: 'T' }],
      variants: [{ name: 'featured' }],
      layout: [{ tag: 'p', text: '{title}', style: { position: 'relative' } }],
    });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    const cardId = (r.dataIds.find((id) => id !== 'switch-card-root') ?? 'switch-card-root') as string;
    const updated = updateVariantStyleInCode(r.masterCode, cardId, 'featured', { backgroundColor: '#eef0ff' });
    expect(updated).not.toBe(r.masterCode);
    const vs = checkFile(updated, { kind: 'component', path: 'components/SwitchCard.tsx' });
    expect(vs.map((v) => v.code)).toEqual([]);
  });
});
