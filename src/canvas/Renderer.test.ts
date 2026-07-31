// Renderer.test.ts — Tests for shouldUseInnerHTML guard (SVG innerHTML prevention)
// and canvas-tokens marker system (preset live-update regression).

import { describe, test, it, expect, beforeEach } from 'vitest';
import { shouldUseInnerHTML } from './Renderer';
import { setElStyle, clearElStyle } from './renderer/style-apply';
import { applyBindingDataToTree } from './renderer/bindings';
import { collectionBindingSignature, shouldClearEmptiedText } from './Renderer';
import { refreshCanvasTokens } from './node-ops';
import { resetProjectFS } from '@/code/project/project-fs';
import { parseJSXToNodes } from '@/code/parsing/parser';

// ─── Preset token live-update regression ────────────────────────────────────
//
// Bug: Renderer wrote style element as `tokensCSS + pageCSS` (no markers).
// refreshCanvasTokens() couldn't find markers → prepended updated tokens BEFORE
// the old content. Old :root block at the bottom won via CSS last-rule-wins
// cascade → preset color changes had no visual effect.
//
// Fix: Renderer now wraps tokensCSS with /* canvas-tokens-start/end */ markers.
// refreshCanvasTokens() finds markers and replaces just that section in-place.
//
// These tests lock in that contract so the bug cannot silently regress.

describe('canvas-tokens marker system — preset live-update regression', () => {
  let contentRoot: HTMLDivElement;
  let styleEl: HTMLStyleElement;

  beforeEach(() => {
    // Set up a minimal DOM that node-ops.ts expects
    contentRoot = document.createElement('div');
    contentRoot.setAttribute('data-content-root', 'true');
    document.body.appendChild(contentRoot);

    // Pre-create the style element as the Renderer would after its first render
    styleEl = document.createElement('style');
    styleEl.setAttribute('data-canvas-styles', 'true');
    contentRoot.prepend(styleEl);

    return () => {
      contentRoot.remove();
    };
  });

  test('Renderer output contains canvas-tokens-start/end markers wrapping tokensCSS', () => {
    // Simulate what the Renderer now writes: markers + tokensCSS + pageCSS
    const tokensCSS = ':root { --color-brand: #ff0000; }';
    const pageCSS = '.hero { background: var(--color-brand); }';
    const rendered = `/* canvas-tokens-start */\n${tokensCSS}\n/* canvas-tokens-end */\n${pageCSS}`;

    styleEl.textContent = rendered;

    expect(styleEl.textContent).toContain('/* canvas-tokens-start */');
    expect(styleEl.textContent).toContain('/* canvas-tokens-end */');
    // tokensCSS is between the markers, NOT floating at the end
    const start = styleEl.textContent!.indexOf('/* canvas-tokens-start */');
    const end = styleEl.textContent!.indexOf('/* canvas-tokens-end */');
    expect(styleEl.textContent!.slice(start, end)).toContain('--color-brand: #ff0000');
  });

  test('refreshCanvasTokens replaces token value in-place — old value absent, new value present once', async () => {
    // Simulate: Renderer ran with old tokens, wrote markers
    const oldTokens = ':root { --color-brand: #ff0000; }';
    const pageCSS = '.hero { background: var(--color-brand); }';
    styleEl.textContent = `/* canvas-tokens-start */\n${oldTokens}\n/* canvas-tokens-end */\n${pageCSS}`;

    // User updates preset → tokens.css now has new value
    const newTokens = ':root { --color-brand: #00ff00; }';
    resetProjectFS(new Map([['app/globals.css', newTokens]]));

    refreshCanvasTokens();
    // refreshCanvasTokens is RAF-coalesced now — the write lands next frame.
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    const content = styleEl.textContent!;
    expect(content).toContain('#00ff00');          // new value present
    expect(content).not.toContain('#ff0000');       // old value gone
    expect(content).toContain('/* canvas-tokens-start */');
    expect(content).toContain('/* canvas-tokens-end */');
    expect(content).toContain(pageCSS);            // page CSS still intact
  });

  test('refreshCanvasTokens does NOT duplicate the tokens block — old value appears exactly 0 times', async () => {
    // This is the exact regression: if markers are missing, refreshCanvasTokens
    // prepends new tokens but leaves old tokens at the end → old value wins cascade.
    const oldTokens = ':root { --color-brand: #ff0000; }';
    styleEl.textContent = `/* canvas-tokens-start */\n${oldTokens}\n/* canvas-tokens-end */\n`;

    const newTokens = ':root { --color-brand: #00ff00; }';
    resetProjectFS(new Map([['app/globals.css', newTokens]]));

    refreshCanvasTokens();
    // refreshCanvasTokens is RAF-coalesced now — the write lands next frame.
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    const content = styleEl.textContent!;
    // Count occurrences — must be exactly 1 for new value, 0 for old value
    const newCount = (content.match(/#00ff00/g) || []).length;
    const oldCount = (content.match(/#ff0000/g) || []).length;
    expect(newCount).toBe(1);
    expect(oldCount).toBe(0);
  });

  test('refreshCanvasTokens preserves page CSS after the tokens block', () => {
    const oldTokens = ':root { --color-brand: #ff0000; }';
    const pageCSS = '.card { color: var(--color-brand); font-size: 16px; }';
    styleEl.textContent = `/* canvas-tokens-start */\n${oldTokens}\n/* canvas-tokens-end */\n${pageCSS}`;

    resetProjectFS(new Map([['app/globals.css', ':root { --color-brand: #00ff00; }']]));

    refreshCanvasTokens();

    expect(styleEl.textContent).toContain(pageCSS);
  });
});

// ─── isCanvasNode filtering in patchChildElements ────────────────────────────
//
// patchChildElements filters out children with isCanvasNode=true because those
// are hoisted to container level (not rendered inside viewports).
// We verify this indirectly by checking that the parser correctly sets isCanvasNode
// and that shouldUseInnerHTML (which runs for each rendered node) would not be
// called for canvas nodes (they skip the render path entirely).

describe('isCanvasNode detection — parser sets flag from data-canvas-node attribute', () => {
  // This is a "contract test" — verifying the parser output that Renderer relies on.
  // When parser produces isCanvasNode=true, patchChildElements skips the node.

  test('node with data-canvas-node="true" attribute is marked as isCanvasNode', () => {
    const code = `<div data-id="root" style={{position: 'relative', width: '1440px'}}>
  <div data-id="canvas-thing" data-canvas-node="true" style={{position: 'absolute', left: '100px', top: '100px', width: '200px', height: '200px'}}>Canvas</div>
  <div data-id="normal" style={{width: '100%'}}>Normal</div>
</div>`;
    const nodes = parseJSXToNodes(code);
    const canvasNode = nodes.get('canvas-thing');
    const normalNode = nodes.get('normal');

    expect(canvasNode).toBeDefined();
    expect(canvasNode!.isCanvasNode).toBe(true);
    expect(normalNode).toBeDefined();
    expect(normalNode!.isCanvasNode).toBe(false);
  });

  test('children array excludes isCanvasNode children in patchChildElements filter logic', () => {
    // Verify the filtering logic that patchChildElements uses:
    // childIds.filter(id => !allNodes.get(id)?.isCanvasNode)
    const code = `<div data-id="root" style={{position: 'relative', width: '1440px'}}>
  <div data-id="canvas-thing" data-canvas-node="true" style={{position: 'absolute'}}>Canvas</div>
  <div data-id="normal-a" style={{width: '100%'}}>A</div>
  <div data-id="normal-b" style={{width: '100%'}}>B</div>
</div>`;
    const nodes = parseJSXToNodes(code);
    const root = nodes.get('root')!;

    // Simulate the filter from patchChildElements line 379-381:
    const filteredIds = root.children.filter((id: string) => !nodes.get(id)?.isCanvasNode);

    expect(root.children).toContain('canvas-thing');
    expect(filteredIds).not.toContain('canvas-thing');
    expect(filteredIds).toContain('normal-a');
    expect(filteredIds).toContain('normal-b');
  });
});

// ─── shouldUseInnerHTML ─────────────────────────────────────────────────────

describe('shouldUseInnerHTML', () => {
  // --- SVG nodes must NEVER use innerHTML ---

  test('svg type returns false even with HTML-like textContent', () => {
    expect(shouldUseInnerHTML('svg', '<polygon points="0,0 50,50 100,0" />', false, 0)).toBe(false);
  });

  test('svg type returns false with hasMixedContent=true', () => {
    expect(shouldUseInnerHTML('svg', '<circle cx="50" cy="50" r="40" />', true, 0)).toBe(false);
  });

  test('svg type returns false with children', () => {
    expect(shouldUseInnerHTML('svg', '<path d="M0,0 L100,100" />', false, 2)).toBe(false);
  });

  // SVG child tags (rect, circle, etc.) should also be excluded
  test('rect type returns false', () => {
    expect(shouldUseInnerHTML('rect', 'some text', true, 0)).toBe(false);
  });

  test('circle type returns false', () => {
    expect(shouldUseInnerHTML('circle', 'some text', true, 0)).toBe(false);
  });

  test('path type returns false', () => {
    expect(shouldUseInnerHTML('path', '<nested />', false, 0)).toBe(false);
  });

  test('polygon type returns false', () => {
    expect(shouldUseInnerHTML('polygon', '<nested />', true, 0)).toBe(false);
  });

  test('line type returns false', () => {
    expect(shouldUseInnerHTML('line', 'x', true, 0)).toBe(false);
  });

  test('ellipse type returns false', () => {
    expect(shouldUseInnerHTML('ellipse', 'x', true, 0)).toBe(false);
  });

  test('polyline type returns false', () => {
    expect(shouldUseInnerHTML('polyline', 'x', true, 0)).toBe(false);
  });

  test('g type returns false', () => {
    expect(shouldUseInnerHTML('g', 'x', true, 0)).toBe(false);
  });

  // --- Normal (non-SVG) elements ---

  test('div with hasMixedContent=true returns true', () => {
    expect(shouldUseInnerHTML('div', 'Hello <span>world</span>', true, 0)).toBe(true);
  });

  test('div with textContent containing < and no children returns true', () => {
    expect(shouldUseInnerHTML('div', 'Hello <br/> world', false, 0)).toBe(true);
  });

  test('div with plain textContent and no children returns false', () => {
    expect(shouldUseInnerHTML('div', 'Hello world', false, 0)).toBe(false);
  });

  test('div with textContent containing < but HAS children returns false', () => {
    expect(shouldUseInnerHTML('div', 'Hello <br/>', false, 2)).toBe(false);
  });

  test('p with hasMixedContent=true and children returns true', () => {
    expect(shouldUseInnerHTML('p', 'Hello <strong>bold</strong>', true, 1)).toBe(true);
  });

  test('span with empty textContent returns false', () => {
    expect(shouldUseInnerHTML('span', '', false, 0)).toBe(false);
  });

  test('div with empty textContent and hasMixedContent returns false', () => {
    expect(shouldUseInnerHTML('div', '', true, 0)).toBe(false);
  });

  test('isChildrenSlot=true always returns false regardless of other params', () => {
    expect(shouldUseInnerHTML('div', 'Hello <span>world</span>', true, 0, true)).toBe(false);
  });

  test('isChildrenSlot=false falls through to normal logic', () => {
    expect(shouldUseInnerHTML('div', 'Hello <span>world</span>', true, 0, false)).toBe(true);
  });
});

// ─── Custom-property style application (overlay-border variable regression) ──
//
// Bug: the Renderer applied styles via `el.style[key] = v`, which is a SILENT
// NO-OP for CSS custom properties (`--x`). A component overlay-border variable
// binds through a custom property — `--X` on the root + `border: var(--X)` in
// the injected `::after` — so the canvas never set `--X` and the overlay border
// resolved to empty (visible only while BorderControl's imperative resolved
// injection lingered; it vanished on the next full re-render / master-nav).
// setElStyle/clearElStyle must route `--x` keys through setProperty/removeProperty.
describe('setElStyle / clearElStyle — CSS custom properties', () => {
  test('setElStyle applies a custom property (var() can resolve)', () => {
    const el = document.createElement('div');
    setElStyle(el, '--azegazegzeg', '152px solid #000000');
    expect(el.style.getPropertyValue('--azegazegzeg')).toBe('152px solid #000000');
    // Proves the previous bracket-assignment path would NOT have worked:
    const bracketEl = document.createElement('div');
    (bracketEl.style as any)['--azegazegzeg'] = '152px solid #000000';
    expect(bracketEl.style.getPropertyValue('--azegazegzeg')).toBe('');
  });

  test('setElStyle still applies normal camelCase props', () => {
    const el = document.createElement('div');
    setElStyle(el, 'backgroundColor', '#97cffc');
    expect(el.style.backgroundColor).toBe('rgb(151, 207, 252)');
  });

  test('clearElStyle removes a custom property', () => {
    const el = document.createElement('div');
    el.style.setProperty('--foo', 'bar');
    clearElStyle(el, '--foo');
    expect(el.style.getPropertyValue('--foo')).toBe('');
  });

  // Raw-number variables (`gap = 61`) store the bare string "61"; `el.style.gap = "61"` is invalid CSS.
  // setElStyle must append px for px-properties (mirroring React) and leave unitless props raw.
  test('setElStyle appends px to a bare number for a px-property (gap)', () => {
    const el = document.createElement('div');
    setElStyle(el, 'gap', '61');
    expect(el.style.gap).toBe('61px');
  });

  test('setElStyle appends px to padding/fontSize bare numbers', () => {
    const el = document.createElement('div');
    setElStyle(el, 'padding', '16');
    setElStyle(el, 'fontSize', '24');
    expect(el.style.padding).toBe('16px');
    expect(el.style.fontSize).toBe('24px');
  });

  test('setElStyle leaves UNITLESS props raw (opacity, zIndex, lineHeight)', () => {
    const el = document.createElement('div');
    setElStyle(el, 'opacity', '0.38');
    setElStyle(el, 'zIndex', '5');
    setElStyle(el, 'lineHeight', '1.5');
    expect(el.style.opacity).toBe('0.38');
    expect(el.style.zIndex).toBe('5');
    expect(el.style.lineHeight).toBe('1.5');
  });

  test('setElStyle does not touch values that already have a unit or keyword', () => {
    const el = document.createElement('div');
    setElStyle(el, 'gap', '61px');
    setElStyle(el, 'justifyContent', 'center');
    expect(el.style.gap).toBe('61px');
    expect(el.style.justifyContent).toBe('center');
  });

  test('clearElStyle clears a normal prop', () => {
    const el = document.createElement('div');
    el.style.width = '10px';
    clearElStyle(el, 'width');
    expect(el.style.width).toBe('');
  });
});

import { resolveVariantStyles } from './Renderer';
import type { CanvasNode } from '@/code/parsing/parser';

describe('resolveVariantStyles — code-component instance per-variant size (master artboards)', () => {
  // A vector-set instance whose width/height are `variant === 'variant-1' ? a : b`
  // ternaries → parsed into node.conditionalStyles. The Renderer's isCodeComponent
  // branch routes the container through here so each artboard tile sizes to its
  // OWN variant (was returning raw node.styles = default branch → resize reverted).
  const node = {
    id: 'vector-1',
    type: 'PoSuTa',
    parentId: 'frame-1',
    children: [],
    isCodeComponent: true,
    styles: { position: 'absolute', left: '468px', top: '94px', width: '332px', height: '331px' },
    conditionalStyles: {
      left: { 'variant-1': '189px', default: '468px' },
      width: { 'variant-1': '457px', default: '332px' },
      height: { 'variant-1': '455px', default: '331px' },
    },
    attrs: {},
    textContent: null,
  } as unknown as CanvasNode;

  it('resolves the variant-1 branch on the variant-1 tile', () => {
    const r = resolveVariantStyles(node, 'variant-1');
    expect(r.width).toBe('457px');
    expect(r.height).toBe('455px');
    expect(r.left).toBe('189px');
  });

  it('resolves the default branch on the default (primary) tile', () => {
    const r = resolveVariantStyles(node, 'default');
    expect(r.width).toBe('332px');
    expect(r.height).toBe('331px');
  });

  it('falls back to base styles when no variant is active', () => {
    const r = resolveVariantStyles(node, null);
    expect(r.width).toBe('332px');
  });
});

// ─── Per-viewport instance PROP overrides (responsivePropStyles) ─────────────
// A design-component instance prop variable (e.g. `direction`) set on a replica
// is written to `data-responsive`; expandComponent lowers it to the style it
// drives (flexDirection) keyed by viewport width. resolveVariantStyles applies
// it per replica so the canvas tile matches what withResponsiveProps renders live.
describe('resolveVariantStyles — per-viewport instance prop overrides', () => {
  const node = {
    id: 'frame:root', type: 'div', parentId: null, children: [],
    styles: { display: 'flex', flexDirection: 'row', backgroundColor: '#97cffc' },
    responsivePropStyles: {
      768: { flexDirection: 'column' },
      375: { flexDirection: 'column', backgroundColor: '#ff0000' },
    },
    attrs: {}, textContent: null,
  } as unknown as CanvasNode;

  test('primary viewport (1440, no key) keeps the base', () => {
    const r = resolveVariantStyles(node, null, 1440);
    expect(r.flexDirection).toBe('row');
    expect(r.backgroundColor).toBe('#97cffc');
  });

  test('tablet (768) applies its flexDirection override only', () => {
    const r = resolveVariantStyles(node, null, 768);
    expect(r.flexDirection).toBe('column');
    expect(r.backgroundColor).toBe('#97cffc');
  });

  test('mobile (375) applies both overrides', () => {
    const r = resolveVariantStyles(node, null, 375);
    expect(r.flexDirection).toBe('column');
    expect(r.backgroundColor).toBe('#ff0000');
  });

  test('no vpWidth (master view) → base', () => {
    expect(resolveVariantStyles(node, null).flexDirection).toBe('row');
  });
});

// ─── Ghost style-binding empty-field reset (collection-list regression) ──────
//
// Bug: a CMS-bound style (e.g. a card backgroundColor bound to `item.color`)
// was set ONLY on item 0. On a count-unchanged ghost update the canvas first
// copies the template (item-0) styles onto every ghost row via
// `syncInlineStyles`, then re-applies each row's bound field. The old code
// SKIPPED rows whose field was empty — leaving item-0's copied color behind,
// so every row showed item 0's color on the canvas while live (real React)
// correctly fell back to the component's prop default for the empty rows.
//
// Fix: an empty bound field now RESETS that style prop to the node's base
// (default) style, matching live's "undefined field → prop default" fallback.

describe('applyBindingDataToTree — empty bound style field resets to default', () => {
  function leaf(styleBindings: NonNullable<CanvasNode['styleBindings']>, baseStyles: Record<string, string>): CanvasNode {
    return {
      id: 'card', type: 'div', children: [],
      styles: baseStyles,
      styleBindings,
    } as unknown as CanvasNode;
  }

  test('applies the field value when the row HAS one', () => {
    const ghost = document.createElement('div');
    // syncInlineStyles already copied item-0's brown onto this ghost.
    ghost.style.backgroundColor = 'rgb(120, 80, 40)';
    const node = leaf([{ styleProp: 'backgroundColor', field: 'color' }], { backgroundColor: '#97cffc' });
    applyBindingDataToTree(ghost, node, new Map(), { color: '#ff0000' } as any, '__1', '');
    expect(ghost.style.backgroundColor).toBe('rgb(255, 0, 0)');
  });

  test('resets to the node base style when the row field is MISSING (not item-0 leak)', () => {
    const ghost = document.createElement('div');
    ghost.style.backgroundColor = 'rgb(120, 80, 40)'; // item-0 brown leaked by syncInlineStyles
    const node = leaf([{ styleProp: 'backgroundColor', field: 'color' }], { backgroundColor: '#97cffc' });
    applyBindingDataToTree(ghost, node, new Map(), {} as any, '__2', '');
    // Must drop back to the default — NOT keep the brown.
    expect(ghost.style.backgroundColor).not.toBe('rgb(120, 80, 40)');
    expect(ghost.style.backgroundColor).toBe('rgb(151, 207, 252)'); // #97cffc
  });

  test('clears the prop when the field is empty AND there is no base style', () => {
    const ghost = document.createElement('div');
    ghost.style.backgroundColor = 'rgb(120, 80, 40)';
    const node = leaf([{ styleProp: 'backgroundColor', field: 'color' }], {});
    applyBindingDataToTree(ghost, node, new Map(), { color: '' } as any, '__3', '');
    expect(ghost.style.backgroundColor).toBe('');
  });
});

describe('applyBindingDataToTree — per-viewport CMS rebind / unbind→default', () => {
  test('STYLE: a per-viewport field-ref rebinds to a DIFFERENT field on that viewport only', () => {
    const node = {
      id: 'card', type: 'div', children: [],
      styles: { backgroundColor: '#000000' },
      styleBindings: [{ styleProp: 'backgroundColor', field: 'color' }],
      responsiveBindings: { style: { 768: { backgroundColor: { field: 'altColor' } } } },
    } as unknown as CanvasNode;
    const row = { color: '#ff0000', altColor: '#00ff00' } as any;
    // Tablet (768) → the rebound field (green).
    const g1 = document.createElement('div');
    applyBindingDataToTree(g1, node, new Map(), row, '__1', '', 768);
    expect(g1.style.backgroundColor).toBe('rgb(0, 255, 0)');
    // Desktop (1440, no override) → the base field (red).
    const g2 = document.createElement('div');
    applyBindingDataToTree(g2, node, new Map(), row, '__2', '', 1440);
    expect(g2.style.backgroundColor).toBe('rgb(255, 0, 0)');
  });

  test('TEXT: unbind→default literal renders on its viewport, base field elsewhere', () => {
    const node = {
      id: 't', type: 'p', children: [],
      styles: {},
      binding: { field: 'title', property: 'text' },
      responsiveBindings: { text: { 375: { value: 'Untitled' } } },
    } as unknown as CanvasNode;
    const row = { title: 'Marcus Chen' } as any;
    // Mobile (375) → the literal default (unbind→default).
    const g1 = document.createElement('p');
    applyBindingDataToTree(g1, node, new Map(), row, '__1', '', 375);
    expect(g1.textContent).toBe('Untitled');
    // Desktop (no override) → the base bound field value.
    const g2 = document.createElement('p');
    applyBindingDataToTree(g2, node, new Map(), row, '__2', '', 1440);
    expect(g2.textContent).toBe('Marcus Chen');
  });

  test('no vpWidth / no responsiveBindings → behaves exactly like the base binding', () => {
    const node = {
      id: 't2', type: 'p', children: [], styles: {},
      binding: { field: 'title', property: 'text' },
    } as unknown as CanvasNode;
    const g = document.createElement('p');
    applyBindingDataToTree(g, node, new Map(), { title: 'Base' } as any, '__1', '');
    expect(g.textContent).toBe('Base');
  });

  test('PER-VARIANT (component master): variantBindings rebinds text on its variant, base elsewhere', () => {
    const node = {
      id: 'h', type: 'h3', children: [], styles: {},
      binding: { field: 'role', property: 'text' },
      variantBindings: { text: { 'variant-1': { field: 'title' }, 'variant-2': { value: 'N/A' } } },
    } as unknown as CanvasNode;
    const row = { role: 'CEO', title: 'Chief' } as any;
    // variant-1 artboard → rebound field.
    const g1 = document.createElement('h3');
    applyBindingDataToTree(g1, node, new Map(), row, '__1', '', undefined, 'variant-1');
    expect(g1.textContent).toBe('Chief');
    // variant-2 artboard → unbind→default literal.
    const g2 = document.createElement('h3');
    applyBindingDataToTree(g2, node, new Map(), row, '__1', '', undefined, 'variant-2');
    expect(g2.textContent).toBe('N/A');
    // default/primary artboard (no override) → base field.
    const g3 = document.createElement('h3');
    applyBindingDataToTree(g3, node, new Map(), row, '__1', '', undefined, 'default');
    expect(g3.textContent).toBe('CEO');
  });

  test('PAGE INSTANCE per-viewport variant: resolves via responsiveVariantMap[vpWidth]', () => {
    // Instance with data-responsive setting variant-1 on tablet (768) → the tablet ghost
    // must resolve variantBindings['variant-1'] even with no variantName passed.
    const node = {
      id: 'h', type: 'h3', children: [], styles: {},
      binding: { field: 'role', property: 'text' },
      variantBindings: { text: { 'variant-1': { field: 'bio' } } },
      responsiveVariantMap: { 768: 'variant-1' },
      componentVariant: null,
    } as unknown as CanvasNode;
    const row = { role: 'CEO', bio: 'Long bio…' } as any;
    const tablet = document.createElement('h3');
    applyBindingDataToTree(tablet, node, new Map(), row, '__1', '', 768); // vpWidth=768, no variantName
    expect(tablet.textContent).toBe('Long bio…');  // resolved variant-1 via responsiveVariantMap[768]
    const desktop = document.createElement('h3');
    applyBindingDataToTree(desktop, node, new Map(), row, '__1', '', 1440); // no entry → base
    expect(desktop.textContent).toBe('CEO');
  });

  test('PAGE INSTANCE: no variantName → falls back to the baked componentVariant', () => {
    // An instance on a page set to "variant-1" — expandComponent baked componentVariant.
    // The page render passes no variantName, so resolution must use componentVariant.
    const node = {
      id: 'h', type: 'h3', children: [], styles: {},
      binding: { field: 'role', property: 'text' },
      variantBindings: { text: { 'variant-1': { field: 'bio' } } },
      componentVariant: 'variant-1',
    } as unknown as CanvasNode;
    const g = document.createElement('h3');
    applyBindingDataToTree(g, node, new Map(), { role: 'CEO', bio: 'Long bio…' } as any, '__1', ''); // no vpWidth, no variantName
    expect(g.textContent).toBe('Long bio…'); // resolved via componentVariant, not the base
  });
});

// ─── Ghost rebuild on a BINDING change ──────────────────────────────────────
//
// `applyBindingDataToTree` only ever WRITES a bound value — it has nothing to
// say about a field that is no longer bound, so a ghost row keeps painting the
// last value it was handed. Unbinding Content (× on the pill) left every row in
// the list showing its old text although the JSX was already correct; it only
// cleared on the full rebuild a page switch does (user report 2026-07-25).
// The structural signature can't catch it either — the DOM tree is IDENTICAL
// before and after an unbind. So the patch compares a BINDING signature and
// falls through to a rebuild when it moves.

describe('collectionBindingSignature', () => {
  function node(over: Partial<CanvasNode>): CanvasNode {
    return { id: 'tpl', type: 'div', children: [], styles: {}, ...over } as unknown as CanvasNode;
  }
  const bound = node({ binding: { field: 'title', property: 'text' } });
  const unbound = node({});

  test('changes when a text binding is REMOVED', () => {
    expect(collectionBindingSignature(bound, new Map()))
      .not.toBe(collectionBindingSignature(unbound, new Map()));
  });

  test('changes when a binding is re-pointed at another field', () => {
    const other = node({ binding: { field: 'excerpt', property: 'text' } });
    expect(collectionBindingSignature(bound, new Map()))
      .not.toBe(collectionBindingSignature(other, new Map()));
  });

  test('is stable when nothing about the bindings changed', () => {
    const same = node({ binding: { field: 'title', property: 'text' } });
    expect(collectionBindingSignature(bound, new Map()))
      .toBe(collectionBindingSignature(same, new Map()));
  });

  test('covers attr, style and prop bindings', () => {
    const a = node({ attrBindings: [{ property: 'src', field: 'image' }] });
    const b = node({ styleBindings: [{ styleProp: 'backgroundColor', field: 'color' }] });
    const c = node({ propBindings: [{ prop: 'label', field: 'title' }] });
    const sigs = [a, b, c, unbound].map(n => collectionBindingSignature(n, new Map()));
    expect(new Set(sigs).size).toBe(4); // all distinct
  });

  test('walks CHILDREN of the template, not just its root', () => {
    const nodes = new Map<string, CanvasNode>();
    const child = node({ id: 'kid', binding: { field: 'body', property: 'text' } });
    nodes.set('kid', child);
    const root = node({ id: 'tpl', children: ['kid'] });
    const withChildBinding = collectionBindingSignature(root, nodes);
    nodes.set('kid', node({ id: 'kid' })); // child unbound
    expect(collectionBindingSignature(root, nodes)).not.toBe(withChildBinding);
  });

  test('is empty for a template with no bindings anywhere', () => {
    expect(collectionBindingSignature(unbound, new Map())).toBe('');
  });

  test('survives a cyclic parent/child graph', () => {
    const nodes = new Map<string, CanvasNode>();
    nodes.set('a', node({ id: 'a', children: ['b'] }));
    nodes.set('b', node({ id: 'b', children: ['a'] }));
    expect(() => collectionBindingSignature(nodes.get('a')!, nodes)).not.toThrow();
  });
});

// ─── Emptied text must actually clear ───────────────────────────────────────
//
// patchElement's text write is gated on the resolved text being TRUTHY, so a
// node whose content became '' kept painting whatever the DOM last held.
// Unbinding Content writes an EMPTY static value, so the collection template
// row (item 0 — the only row patched here; ghosts go via
// applyBindingDataToTree) still showed the old field value until a page switch
// (user report 2026-07-25).

describe('shouldClearEmptiedText', () => {
  const text = (over: Partial<CanvasNode> = {}) =>
    ({ type: 'h3', children: [], ...over }) as unknown as CanvasNode;

  test('clears an emptied TEXT leaf that still paints something', () => {
    expect(shouldClearEmptiedText(text(), '', false, true)).toBe(true);
    expect(shouldClearEmptiedText(text(), undefined, false, true)).toBe(true);
  });

  test('no-op when the node still HAS text (normal write path owns it)', () => {
    expect(shouldClearEmptiedText(text(), 'Hello', false, true)).toBe(false);
  });

  test('no-op while a live CMS field owns the text', () => {
    expect(shouldClearEmptiedText(text(), '', true, true)).toBe(false);
  });

  test('no-op when the DOM is already empty', () => {
    expect(shouldClearEmptiedText(text(), '', false, false)).toBe(false);
  });

  test('no-op for a node with model children', () => {
    expect(shouldClearEmptiedText(text({ children: ['kid'] }), '', false, true)).toBe(false);
  });

  test('never blanks a NON-text leaf (React root / bg video / slot ghost live there)', () => {
    for (const type of ['div', 'section', 'img', 'video', 'svg', 'Marquee']) {
      expect(shouldClearEmptiedText(text({ type }), '', false, true)).toBe(false);
    }
  });

  test('covers the motion.* text tags', () => {
    expect(shouldClearEmptiedText(text({ type: 'motion.h3' }), '', false, true)).toBe(true);
    expect(shouldClearEmptiedText(text({ type: 'motion.p' }), '', false, true)).toBe(true);
  });

  // RICH TEXT. `<p><span style="color:…">typed</span></p>` — what styling text
  // inside the editor produces — parses to hasMixedContent with an EMPTY
  // textContent (the content is markup), and shouldUseInnerHTML bails on that
  // empty string too. Clearing wiped the span: type a new text node, pick a
  // colour before committing, and the content vanished on commit (user report
  // 2026-07-25, regression from this very helper).
  test('never blanks a rich-text node (content is markup, textContent is empty)', () => {
    expect(shouldClearEmptiedText(text({ hasMixedContent: true }), '', false, true)).toBe(false);
    expect(shouldClearEmptiedText(text({ hasMixedContent: true }), undefined, false, true)).toBe(false);
  });

  test('never blanks a {children} slot (that DOM is the page content)', () => {
    expect(shouldClearEmptiedText(text({ isChildrenSlot: true }), '', false, true)).toBe(false);
  });
});

// The same case driven through the REAL parser, so a change in how rich text
// is modelled can't quietly re-open it. This is the exact JSX the text creator
// commits when the user colours the text before clicking away — captured from
// the debug trace of the report.
describe('emptied-text clear vs the real parser output', () => {
  const CODE = `export default function Page() {
  return <div data-id="root"></div>;
}
const canvasNodes = <>
  <div data-id="frame-a" data-canvas-node="true" style={{ width: '400px' }}>
    <p data-id="text-x" data-name="Text" style={{ fontSize: '16px' }}>
      <span style={{ color: 'rgb(255, 255, 255)' }}>qsdgqsdgqsdgqsdg</span>
    </p>
    <p data-id="text-plain" data-name="Text" style={{ fontSize: '16px' }}>plain words</p>
  </div>
</>;`;

  test('a span-only rich text carries its inner JSX and renders via innerHTML', () => {
    // The canvasNodes walker used to detect `hasMixedContent` but leave
    // textContent EMPTY, so shouldUseInnerHTML bailed and NOTHING ever painted
    // the span — the text vanished on every full rebuild. Both halves are
    // asserted here because they have to agree: mixed content must come with
    // the raw inner JSX, and that's what routes it to the innerHTML path.
    const n = parseJSXToNodes(CODE).get('text-x')!;
    expect(n.hasMixedContent).toBe(true);
    expect(n.textContent).toContain('qsdgqsdgqsdgqsdg');
    expect(shouldUseInnerHTML(n.type, n.textContent ?? '', !!n.hasMixedContent, n.children.length)).toBe(true);
  });

  test('the clear still must NOT fire for a mixed-content node', () => {
    // Defence in depth: even with the parser fixed, an empty textContent on a
    // mixed-content node must never be read as "this node is blank".
    const n = parseJSXToNodes(CODE).get('text-x')!;
    expect(shouldClearEmptiedText(n, n.textContent, false, true)).toBe(false);
    expect(shouldClearEmptiedText(n, '', false, true)).toBe(false);
  });

  test('a plain text node that really went empty still clears', () => {
    const n = parseJSXToNodes(CODE).get('text-plain')!;
    expect(shouldClearEmptiedText(n, '', false, true)).toBe(true);
  });
});

// ─── background shorthand clear wipes longhands (fill image-apply bug) ───────
//
// CSSOM semantics: assigning the `background` SHORTHAND (even to '') clears
// EVERY background-* longhand on the inline style — including ones set
// individually. The Fill tool's image-apply batch sends `background: ''`
// before the new backgroundImage; a node whose code already carried
// `backgroundSize: cover` had it wiped from the DOM, and since the value never
// changed in CODE the render diff never repaired it → the new image painted
// at `auto` (huge) until the user touched Size (user report 2026-07-30).
// FillControl now re-writes size/position/repeat UNCONDITIONALLY after the
// clear; this locks the underlying CSSOM behavior those writes exist for.
describe('background shorthand clear semantics (fill image-apply regression)', () => {
  it('clearing `background` wipes an individually-set backgroundSize', () => {
    const el = document.createElement('div');
    setElStyle(el, 'backgroundImage', 'url(old.png)');
    setElStyle(el, 'backgroundSize', 'cover');
    expect(el.style.backgroundSize).toBe('cover');
    clearElStyle(el, 'background');
    expect(el.style.backgroundSize).toBe('');
    expect(el.style.backgroundImage).toBe('');
  });

  it('the fixed apply sequence leaves size/position/repeat correct after the clear', () => {
    const el = document.createElement('div');
    setElStyle(el, 'backgroundImage', 'url(old.png)');
    setElStyle(el, 'backgroundSize', 'cover');
    // The batch FillControl emits on image apply (clears first, then sets,
    // size/position/repeat re-asserted last):
    clearElStyle(el, 'backgroundColor');
    clearElStyle(el, 'background');
    setElStyle(el, 'backgroundImage', 'url(new.png)');
    setElStyle(el, 'backgroundSize', 'cover');
    setElStyle(el, 'backgroundPosition', 'center');
    setElStyle(el, 'backgroundRepeat', 'no-repeat');
    expect(el.style.backgroundImage).toContain('new.png');
    expect(el.style.backgroundSize).toBe('cover');
    expect(el.style.backgroundPosition).toContain('center');
    expect(el.style.backgroundRepeat).toBe('no-repeat');
  });
});
