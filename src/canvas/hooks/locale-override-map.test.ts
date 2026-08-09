// Deterministic canvas text resolution for translation nodes — the Phase 1
// core of the localization overhaul (docs/localization/overhaul-plan.md).
// Repro of the "Peintre stays in English / empty after page switch" report:
// entries must exist for EVERY t() node in EVERY locale (default included),
// with active → default → '' fallback, so the renderer always rewrites text.
import { describe, it, expect } from 'vitest';
import { buildTranslationTextOverrides, parseMessagesNamespace } from './locale-override-map';
import { parseJSXToNodes, type CanvasNode } from '@/code/parsing/parser';

const node = (id: string, translationKey?: string) =>
  ({ id, type: 'p', parentId: 'root', children: [], styles: {}, attrs: {}, textContent: '', translationKey }) as unknown as CanvasNode;

const nodes = new Map<string, CanvasNode>([
  ['title', node('title', 'title')],
  ['subtitle', node('subtitle', 'subtitle')],
  ['plain', node('plain')], // untranslated — must produce NO entry
]);

const en = JSON.stringify({ home: { title: 'Painter', subtitle: 'Visual Artist', title__768: 'Painter (tablet)' } });
const fr = JSON.stringify({ home: { title: 'Peintre' } });

describe('buildTranslationTextOverrides', () => {
  it('active locale wins, default fills gaps, missing = explicit empty string', () => {
    const map = buildTranslationTextOverrides({
      nodes, namespace: 'home', activeMessagesRaw: fr, defaultMessagesRaw: en,
    });
    expect(map.get('title')?.text).toBe('Peintre');
    // subtitle untranslated in fr → falls back to the default-locale text
    expect(map.get('subtitle')?.text).toBe('Visual Artist');
    expect(map.has('plain')).toBe(false);
  });

  it('default locale resolves its own messages (active === default)', () => {
    const map = buildTranslationTextOverrides({
      nodes, namespace: 'home', activeMessagesRaw: en, defaultMessagesRaw: en,
    });
    expect(map.get('title')?.text).toBe('Painter');
  });

  it('a t() node with NO message anywhere still gets an entry (empty text)', () => {
    const map = buildTranslationTextOverrides({
      nodes: new Map([['ghost', node('ghost', 'ghost')]]),
      namespace: 'home', activeMessagesRaw: fr, defaultMessagesRaw: en,
    });
    expect(map.get('ghost')).toEqual({ text: '' });
  });

  it('replica-suffixed keys fold into textOverrides buckets (active over default)', () => {
    const frWithBucket = JSON.stringify({ home: { title: 'Peintre', title__768: 'Peintre (tablette)' } });
    const map = buildTranslationTextOverrides({
      nodes, namespace: 'home', activeMessagesRaw: frWithBucket, defaultMessagesRaw: en,
    });
    expect(map.get('title')?.textOverrides).toEqual({ '768': 'Peintre (tablette)' });
    // Without the active bucket, the default-locale bucket fills in.
    const map2 = buildTranslationTextOverrides({
      nodes, namespace: 'home', activeMessagesRaw: fr, defaultMessagesRaw: en,
    });
    expect(map2.get('title')?.textOverrides).toEqual({ '768': 'Painter (tablet)' });
  });

  it('orphaned messages (no node carries the key) produce nothing', () => {
    const map = buildTranslationTextOverrides({
      nodes: new Map([['plain', node('plain')]]),
      namespace: 'home', activeMessagesRaw: fr, defaultMessagesRaw: en,
    });
    expect(map.size).toBe(0);
  });

  it('attr translation keys resolve into prop overrides', () => {
    const input = { ...node('email'), attrTranslationKeys: { placeholder: 'email__attr_placeholder' } } as unknown as CanvasNode;
    const map = buildTranslationTextOverrides({
      nodes: new Map([['email', input]]),
      namespace: 'home',
      activeMessagesRaw: JSON.stringify({ home: { email__attr_placeholder: 'jeanne@x.fr' } }),
      defaultMessagesRaw: JSON.stringify({ home: { email__attr_placeholder: 'jane@x.com' } }),
    });
    expect(map.get('email')).toEqual({ props: { placeholder: 'jeanne@x.fr' } });
  });

  it('tolerates malformed json and missing namespaces', () => {
    expect(parseMessagesNamespace('{not json', 'home')).toEqual({});
    expect(parseMessagesNamespace(JSON.stringify({ other: { a: 'b' } }), 'home')).toEqual({});
    const map = buildTranslationTextOverrides({
      nodes, namespace: 'home', activeMessagesRaw: '{bad', defaultMessagesRaw: null,
    });
    expect(map.get('title')).toEqual({ text: '' });
  });
});

// ─── Rich-text run substitution (mixed content) ─────────────────────────────

describe('rich-text run substitution', () => {
  const richNode = (id: string, inner: string) =>
    ({ id, type: 'p', parentId: 'root', children: [], styles: {}, attrs: {},
       textContent: inner, hasMixedContent: true }) as unknown as CanvasNode;

  it('resolves {t(key)} runs into an innerJsx override (active → default → empty)', () => {
    const inner = `I'm <span style={{ color: 'red' }}>{t('rich__r1')}</span><br />{t('rich__r2')}`;
    const map = buildTranslationTextOverrides({
      nodes: new Map([['rich', richNode('rich', inner)]]),
      namespace: 'home',
      activeMessagesRaw: JSON.stringify({ home: { rich__r1: 'Jenny !' } }),
      defaultMessagesRaw: JSON.stringify({ home: { rich__r1: 'Jenny,', rich__r2: 'Product Designer' } }),
    });
    const entry = map.get('rich');
    expect(entry?.innerJsx).toBe(`I'm <span style={{ color: 'red' }}>Jenny !</span><br />Product Designer`);
    expect(entry?.text).toBeUndefined();  // never el.textContent — spans must survive
  });

  it('entity-escapes message text so pasted markup cannot inject', () => {
    const inner = `<span>{t('x__r0')}</span>`;
    const map = buildTranslationTextOverrides({
      nodes: new Map([['x', richNode('x', inner)]]),
      namespace: 'home',
      activeMessagesRaw: JSON.stringify({ home: { x__r0: '<img src=x> {evil}' } }),
      defaultMessagesRaw: '{}',
    });
    expect(map.get('x')?.innerJsx).toBe('<span>&lt;img src=x&gt; &#123;evil&#125;</span>');
  });

  it('mixed nodes WITHOUT run calls produce no entry', () => {
    const inner = `Plain <span>styled</span> text`;
    const map = buildTranslationTextOverrides({
      nodes: new Map([['y', richNode('y', inner)]]),
      namespace: 'home', activeMessagesRaw: '{}', defaultMessagesRaw: '{}',
    });
    expect(map.has('y')).toBe(false);
  });
});

// A node dragged out onto the canvas keeps its key in `data-i18n-orphan`
// rather than a `{t()}` call — `t` doesn't exist at module scope. The canvas
// resolver read only the call, so the node stayed in English however the
// locale was switched (user report 2026-08-09).

describe('dormant canvas nodes still resolve', () => {
  const dormant = (id: string, key: string, baked: string) => new Map([[id, {
    id, translationOrphanKey: key, textContent: baked,
  } as never]]);

  it('resolves the stashed key against the active locale', () => {
    const out = buildTranslationTextOverrides({
      nodes: dormant('card', 'card', 'Lunch arrives by boat'),
      namespace: 'home',
      activeMessagesRaw: JSON.stringify({ home: { card: 'Le déjeuner arrive en bateau' } }),
      defaultMessagesRaw: JSON.stringify({ home: { card: 'Lunch arrives by boat' } }),
    });
    expect(out.get('card')?.text).toBe('Le déjeuner arrive en bateau');
  });

  it('falls back to the default locale, then to the BAKED text', () => {
    // The last step is what separates a dormant node from a live one: its
    // baked literal is the only copy left, so resolving to '' would wipe the
    // words off the canvas.
    const nodes = dormant('card', 'card', 'Lunch arrives by boat');
    expect(buildTranslationTextOverrides({
      nodes, namespace: 'home',
      activeMessagesRaw: '{}',
      defaultMessagesRaw: JSON.stringify({ home: { card: 'Lunch arrives by boat' } }),
    }).get('card')?.text).toBe('Lunch arrives by boat');

    expect(buildTranslationTextOverrides({
      nodes, namespace: 'home', activeMessagesRaw: '{}', defaultMessagesRaw: '{}',
    }).get('card')?.text).toBe('Lunch arrives by boat');
  });

  it('a LIVE t() node still resolves to empty when unseeded', () => {
    // Unchanged: its JSX carries no text either way, so '' is honest.
    const out = buildTranslationTextOverrides({
      nodes: new Map([['h', { id: 'h', translationKey: 'h', textContent: '' } as never]]),
      namespace: 'home', activeMessagesRaw: '{}', defaultMessagesRaw: '{}',
    });
    expect(out.get('h')?.text).toBe('');
  });

  it('a live call WINS over a leftover stash', () => {
    // Re-entry restores the call and strips the stash, but the two can coexist
    // for one parse in between. The call is the live truth.
    const out = buildTranslationTextOverrides({
      nodes: new Map([['h', {
        id: 'h', translationKey: 'live', translationOrphanKey: 'stale', textContent: '',
      } as never]]),
      namespace: 'home',
      activeMessagesRaw: JSON.stringify({ home: { live: 'Vivant', stale: 'Périmé' } }),
      defaultMessagesRaw: '{}',
    });
    expect(out.get('h')?.text).toBe('Vivant');
  });
});

// The seam that let the last fix pass its tests and still not work: the
// resolver read `node.attrs['data-i18n-orphan']`, and `attrs` is an ALLOWLIST
// (`PARSED_HTML_ATTRS`) that stash attributes are deliberately off — so the key
// was always undefined in the real app. These tests drive the REAL parser so
// the field name can't drift from what the parser emits.

describe('parser → resolver, on real dormant source', () => {
  const DORMANT_PAGE = `'use client';
import { useTranslations } from "next-intl";
export default function Page() {
  const t = useTranslations("home");
  return <div data-id="root"><h1 data-id="in-page">{t("in-page")}</h1></div>;
}
const canvasNodes = <>
  <div data-id="anchor-text" data-canvas-node="true" style={{ position: 'absolute' }}>
    <h2 data-id="anchor-title" style={{ color: '#fff' }} data-i18n-orphan="anchor-title">Lunch arrives by boat</h2>
  </div>
</>;
`;

  it('the parser surfaces the stash as translationOrphanKey', () => {
    const nodes = parseJSXToNodes(DORMANT_PAGE);
    expect(nodes.get('anchor-title')?.translationOrphanKey).toBe('anchor-title');
    // …and NOT via attrs, which is where the broken version looked.
    expect(nodes.get('anchor-title')?.attrs?.['data-i18n-orphan']).toBeUndefined();
  });

  it('and the resolver translates it end to end', () => {
    const out = buildTranslationTextOverrides({
      nodes: parseJSXToNodes(DORMANT_PAGE),
      namespace: 'home',
      activeMessagesRaw: JSON.stringify({ home: { 'anchor-title': 'Le déjeuner arrive en bateau' } }),
      defaultMessagesRaw: JSON.stringify({ home: { 'anchor-title': 'Lunch arrives by boat' } }),
    });
    expect(out.get('anchor-title')?.text).toBe('Le déjeuner arrive en bateau');
  });
});
