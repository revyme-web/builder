// canvas-node-locale.test.ts — canvas nodes translate like everything else.
//
// A translated section dragged out onto the canvas stayed in English while
// every copy inside the viewports translated (user report 2026-08-09). The
// override map was right — the trace showed 186 nodes painted and not one of
// them a canvas node — because `patchCanvasNodes` / `patchHoistedCanvasNodes` /
// `patchSlotCanvasNodes` were the only render paths that never forwarded
// `localeOverrides` to `patchElement` / `buildNodeElement`. Every viewport call
// site passed it.
//
// Canvas nodes carry no breakpoint, so `vpWidth` stays undefined and
// `applyLocaleOverrides` resolves the flat primary translation.

import { describe, it, expect, beforeEach } from 'vitest';
import { renderNodes } from '../Renderer';
import { parseJSXToNodes } from '@/code/parsing/parser';
import type { NodeOverride } from '@/shared/types';

const PAGE = `'use client';
import { useTranslations } from "next-intl";
export default function Page() {
  const t = useTranslations("home");
  return <div data-id="root" data-name="Page" style={{ width: '100%' }}>
    <h1 data-id="in-page" style={{ color: '#000' }}>{t("in-page")}</h1>
  </div>;
}
const canvasNodes = <>
  <div data-id="anchor-text" data-name="Text" data-canvas-node="true" style={{ position: 'absolute', left: '-874px', top: '1636px' }}>
    <p data-id="anchor-eyebrow" style={{ color: '#E4B22A' }}>The part nobody else sells you</p>
    <h2 data-id="anchor-title" style={{ color: '#fff' }}>Lunch arrives by boat</h2>
  </div>
</>;
`;

const VIEWPORTS = [{ id: 'desktop', width: 1440, x: 0, y: 0, isPrimary: true }] as never;

const overrides = (m: Record<string, string>): Map<string, NodeOverride> =>
  new Map(Object.entries(m).map(([id, text]) => [id, { text }]));

const FR = {
  'in-page': 'Dans la page',
  'anchor-eyebrow': "Ce que personne d'autre ne vous vend",
  'anchor-title': 'Le déjeuner arrive en bateau',
};

let container: HTMLElement;

const render = (locale: string, ov: Map<string, NodeOverride>) =>
  renderNodes(container, parseJSXToNodes(PAGE), null, () => {}, VIEWPORTS, PAGE, locale, 'en', ov);

const textOf = (id: string) =>
  container.querySelector(`[data-node-id="${id}"]`)?.textContent ?? null;

beforeEach(() => {
  (globalThis as any).CSS = (globalThis as any).CSS ?? {};
  (globalThis as any).CSS.escape = (globalThis as any).CSS.escape
    ?? ((s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c: string) => `\\${c}`));
  document.body.innerHTML = '';
  container = document.createElement('div');
  container.setAttribute('data-content-root', 'true');
  document.body.appendChild(container);
});

describe('canvas nodes resolve locale overrides', () => {
  it('translates a node sitting on the canvas', () => {
    render('fr', overrides(FR));
    expect(textOf('anchor-title')).toBe('Le déjeuner arrive en bateau');
    expect(textOf('anchor-eyebrow')).toBe("Ce que personne d'autre ne vous vend");
  });

  it('translates the in-page copy too — the half that already worked', () => {
    render('fr', overrides(FR));
    expect(textOf('in-page')).toBe('Dans la page');
  });

  it('a node with no override keeps its own text', () => {
    render('fr', overrides({ 'in-page': 'Dans la page' }));
    expect(textOf('anchor-title')).toBe('Lunch arrives by boat');
  });

  it('re-rendering into an EXISTING element re-translates it', () => {
    // Build path and patch path are separate call sites, and the patch path is
    // the one a locale switch actually goes through — the element is already
    // in the DOM from the previous locale.
    render('en', overrides({ 'anchor-title': 'Lunch arrives by boat' }));
    expect(textOf('anchor-title')).toBe('Lunch arrives by boat');
    render('fr', overrides(FR));
    expect(textOf('anchor-title')).toBe('Le déjeuner arrive en bateau');
  });
});
