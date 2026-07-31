import { describe, test, expect, beforeEach } from 'vitest';
import { updateNodeInCode, updateNodeTextInCode, updateNodeChildrenFromHTML, reorderNodeInCode, moveNodeInCode, addNodeInCode } from './generator-crud';
import { copyContainerRulesToNewWidth, updateHoverStyleInCode, removeHoverStyleInCode, updatePseudoStyleInCode, removePseudoStyleInCode } from './generator-styles';
import { parseJSXToNodes } from '../parsing/parser';
import { syncViewportWidths } from '../stores/viewport-store';

// ─── Test Helper ───────────────────────────────────────────────────────────

function snapshotNodes(code: string) {
  const nodes = parseJSXToNodes(code);
  const snap: Record<string, { styles: Record<string, string>; text: string; parentId: string | null; children: string[] }> = {};
  for (const [id, node] of nodes) {
    snap[id] = {
      styles: { ...node.styles },
      text: node.textContent,
      parentId: node.parentId,
      children: [...node.children],
    };
  }
  return snap;
}

function assertUnchangedExcept(before: ReturnType<typeof snapshotNodes>, after: ReturnType<typeof snapshotNodes>, changedIds: string[]) {
  for (const id of Object.keys(before)) {
    if (changedIds.includes(id)) continue;
    expect(after[id], `Node ${id} should be unchanged`).toEqual(before[id]);
  }
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

const SIMPLE = `<div data-id="root" style={{position: 'relative', width: '1440px'}}>
  <div data-id="box" style={{position: 'absolute', left: '10px', top: '20px', width: '100px', height: '50px'}}></div>
</div>`;

const FLEX_PAGE = `<div data-id="root" style={{display: 'flex', flexDirection: 'column', gap: '20px'}}>
  <div data-id="child1" style={{width: '100px'}}>One</div>
  <div data-id="child2" style={{width: '200px'}}>Two</div>
  <div data-id="child3" style={{width: '300px'}}>Three</div>
</div>`;

const COMPLEX = `<div data-id="root" style={{position: 'relative', width: '1440px', height: '900px'}}>
  <div data-id="hero" style={{position: 'absolute', left: '0px', top: '0px', width: '1440px', height: '500px', backgroundColor: '#1a1a2e'}}>
    <p data-id="title" style={{fontSize: '52px', color: '#ffffff', fontWeight: '700'}}>Welcome</p>
    <p data-id="subtitle" style={{fontSize: '18px', color: '#aaaaaa'}}>Build websites</p>
  </div>
  <div data-id="features" style={{position: 'absolute', left: '0px', top: '500px', width: '1440px', display: 'flex', gap: '40px'}}>
    <div data-id="card1" style={{width: '300px', backgroundColor: '#f0f0ff'}}>
      <p data-id="card1-text" style={{fontSize: '20px'}}>Feature One</p>
    </div>
    <div data-id="card2" style={{width: '300px', backgroundColor: '#f0fff0'}}>
      <p data-id="card2-text" style={{fontSize: '20px'}}>Feature Two</p>
    </div>
  </div>
</div>`;

// ─── updateNodeInCode ──────────────────────────────────────────────────────

describe('updateNodeInCode', () => {
  test('updates a single style property', () => {
    const result = updateNodeInCode(SIMPLE, 'box', { left: '50px' });
    const nodes = parseJSXToNodes(result);
    expect(nodes.get('box')!.styles.left).toBe('50px');
  });

  test('preserves all other style properties', () => {
    const before = snapshotNodes(SIMPLE);
    const result = updateNodeInCode(SIMPLE, 'box', { left: '50px' });
    const after = snapshotNodes(result);

    expect(after.box.styles.left).toBe('50px');
    expect(after.box.styles.top).toBe(before.box.styles.top);
    expect(after.box.styles.width).toBe(before.box.styles.width);
    expect(after.box.styles.height).toBe(before.box.styles.height);
  });

  test('preserves all other nodes', () => {
    const before = snapshotNodes(SIMPLE);
    const result = updateNodeInCode(SIMPLE, 'box', { left: '50px' });
    const after = snapshotNodes(result);
    assertUnchangedExcept(before, after, ['box']);
  });

  test('adds a new style property', () => {
    const result = updateNodeInCode(SIMPLE, 'box', { backgroundColor: '#ff0000' });
    const nodes = parseJSXToNodes(result);
    expect(nodes.get('box')!.styles.backgroundColor).toBe('#ff0000');
  });

  test('updates multiple properties at once', () => {
    const result = updateNodeInCode(SIMPLE, 'box', { left: '100px', top: '200px' });
    const nodes = parseJSXToNodes(result);
    expect(nodes.get('box')!.styles.left).toBe('100px');
    expect(nodes.get('box')!.styles.top).toBe('200px');
  });

  test('returns unchanged nodes when node not found', () => {
    const before = snapshotNodes(SIMPLE);
    const result = updateNodeInCode(SIMPLE, 'nonexistent', { left: '50px' });
    const after = snapshotNodes(result);
    // All nodes should be identical (Babel may reformat whitespace, so compare nodes not raw string)
    expect(after).toEqual(before);
  });

  // The flex-entry drag commit (canvas node → flex parent) sets position:relative,
  // clears left/top, AND adds `flex` — a prop the canvas node doesn't have yet.
  // The fast path must APPEND the new prop (not bail to a full-file AST round-trip,
  // which is the dominant mouseup cost on a big page) while keeping a trailing
  // `...style` spread LAST (component-instance convention).
  test('adds a new prop via the string fast path, keeping ...style spread last', () => {
    const code = `export default function C() {
  return (<div data-id="chip" style={{ position: 'absolute', left: '-1516px', top: '3159px', ...style }}></div>);
}`;
    const result = updateNodeInCode(code, 'chip', { position: 'relative', left: '', top: '', flex: '0 0 auto' });
    const nodes = parseJSXToNodes(result);
    const s = nodes.get('chip')!.styles;
    expect(s.position).toBe('relative');
    expect(s.left ?? '').toBe('');      // cleared
    expect(s.top ?? '').toBe('');       // cleared
    expect(s.flex).toBe('0 0 auto');    // appended
    // ...style spread must remain the LAST entry in the object literal
    expect(result.indexOf('...style')).toBeGreaterThan(result.indexOf("flex: '0 0 auto'"));
    expect(result).toContain('...style }}');
  });

  // EMPIRICAL PIN, live find 2026-07-29: padding-handle commits inside a
  // component master reverted on mouseup. The fast path used to insert NEW
  // props at the HEAD of the style object — a new `paddingLeft` landed
  // BEFORE the node's existing `padding` SHORTHAND, and React style objects
  // resolve later-keys-win, so the shorthand reset the committed longhand on
  // render. New props must land AFTER every existing key (before a trailing
  // spread) so the write always wins.
  test('a new longhand lands AFTER an existing shorthand (padding-handle commit)', () => {
    const code = `export default function C() {
  return (<div data-id="pad" style={{ padding: '12px', display: 'flex' }}></div>);
}`;
    const result = updateNodeInCode(code, 'pad', { paddingLeft: '87px', paddingRight: '87px' });
    expect(result.indexOf("paddingLeft: '87px'")).toBeGreaterThan(result.indexOf("padding: '12px'"));
    expect(result.indexOf("paddingRight: '87px'")).toBeGreaterThan(result.indexOf("padding: '12px'"));
    const s = parseJSXToNodes(result).get('pad')!.styles;
    expect(s.paddingLeft).toBe('87px');
    expect(s.padding).toBe('12px'); // shorthand untouched, just outranked
  });

  test('a new longhand with a shorthand AND trailing spread sits between them', () => {
    const code = `export default function C() {
  return (<div data-id="pad2" style={{ padding: '12px', ...style }}></div>);
}`;
    const result = updateNodeInCode(code, 'pad2', { paddingTop: '51px' });
    const iShort = result.indexOf("padding: '12px'");
    const iLong = result.indexOf("paddingTop: '51px'");
    const iSpread = result.indexOf('...style');
    expect(iLong).toBeGreaterThan(iShort);
    expect(iSpread).toBeGreaterThan(iLong);
  });
});

// ─── Fast-path objEnd boundary regression (last property removal / update) ─

describe('updateNodeInCode fast-path: last property edge cases', () => {
  // Regression: objEnd -= 2 (off-by-one) caused styleContent to drop the last `'`
  // which made removeRegex consume `'value` and the suffix re-added the quote → double quote.

  test('removing the last property produces valid code (no double quote)', () => {
    // "overflow" is the last property — it has no trailing comma
    const code = `<div data-id="box" style={{position: 'absolute', overflow: 'hidden'}}></div>`;
    const result = updateNodeInCode(code, 'box', { overflow: '' });
    // Must parse cleanly — no syntax error
    const nodes = parseJSXToNodes(result);
    expect(nodes.get('box')!.styles.overflow).toBeUndefined();
    expect(nodes.get('box')!.styles.position).toBe('absolute');
    // Must NOT contain double quote artifact like overflow: 'hidden''
    expect(result).not.toMatch(/hidden''/);
  });

  test('removing a middle property leaves last property intact', () => {
    const code = `<div data-id="box" style={{position: 'absolute', left: '10px', overflow: 'hidden'}}></div>`;
    const result = updateNodeInCode(code, 'box', { left: '' });
    const nodes = parseJSXToNodes(result);
    expect(nodes.get('box')!.styles.left).toBeUndefined();
    expect(nodes.get('box')!.styles.position).toBe('absolute');
    expect(nodes.get('box')!.styles.overflow).toBe('hidden');
  });

  test('updating the last property produces valid code (no double quote)', () => {
    const code = `<div data-id="box" style={{position: 'absolute', overflow: 'hidden'}}></div>`;
    const result = updateNodeInCode(code, 'box', { overflow: 'visible' });
    const nodes = parseJSXToNodes(result);
    expect(nodes.get('box')!.styles.overflow).toBe('visible');
    expect(nodes.get('box')!.styles.position).toBe('absolute');
    expect(result).not.toMatch(/visible''/);
  });

  test('removing only property leaves empty style object', () => {
    const code = `<div data-id="box" style={{overflow: 'hidden'}}></div>`;
    const result = updateNodeInCode(code, 'box', { overflow: '' });
    const nodes = parseJSXToNodes(result);
    expect(nodes.get('box')!.styles.overflow).toBeUndefined();
    // No syntax errors — code must be parseable
    expect(nodes.size).toBeGreaterThan(0);
  });

  test('removing last property when it has numeric value', () => {
    // Regression: [^,}]+ branch — numeric values (no quotes) must also work
    const code = `<div data-id="box" style={{position: 'absolute', zIndex: 10}}></div>`;
    const result = updateNodeInCode(code, 'box', { zIndex: '' });
    const nodes = parseJSXToNodes(result);
    expect(nodes.get('box')!.styles.zIndex).toBeUndefined();
    expect(nodes.get('box')!.styles.position).toBe('absolute');
  });
});

// ─── Roundtrip regression tests ────────────────────────────────────────────

describe('roundtrip: mutations preserve unrelated nodes', () => {
  test('drag hero preserves all other nodes', () => {
    const before = snapshotNodes(COMPLEX);
    const result = updateNodeInCode(COMPLEX, 'hero', { left: '100px', top: '50px' });
    const after = snapshotNodes(result);

    // Changed
    expect(after.hero.styles.left).toBe('100px');
    expect(after.hero.styles.top).toBe('50px');

    // Preserved
    assertUnchangedExcept(before, after, ['hero']);
  });

  test('update card style preserves sibling and parent', () => {
    const before = snapshotNodes(COMPLEX);
    const result = updateNodeInCode(COMPLEX, 'card1', { backgroundColor: '#ff0000' });
    const after = snapshotNodes(result);

    expect(after.card1.styles.backgroundColor).toBe('#ff0000');
    assertUnchangedExcept(before, after, ['card1']);
  });

  test('update deeply nested text preserves everything else', () => {
    const before = snapshotNodes(COMPLEX);
    const result = updateNodeInCode(COMPLEX, 'card1-text', { fontSize: '32px' });
    const after = snapshotNodes(result);

    expect(after['card1-text'].styles.fontSize).toBe('32px');
    assertUnchangedExcept(before, after, ['card1-text']);
  });
});

// ─── reorderNodeInCode ─────────────────────────────────────────────────────

describe('reorderNodeInCode', () => {
  test('moves first child to last position', () => {
    const result = reorderNodeInCode(FLEX_PAGE, 'child1', 'root', 2);
    const nodes = parseJSXToNodes(result);
    const root = nodes.get('root')!;

    // child1 should now be last
    expect(root.children[root.children.length - 1]).toBe('child1');
    // child2 should be first
    expect(root.children[0]).toBe('child2');
  });

  test('moves last child to first position', () => {
    const result = reorderNodeInCode(FLEX_PAGE, 'child3', 'root', 0);
    const nodes = parseJSXToNodes(result);
    const root = nodes.get('root')!;

    expect(root.children[0]).toBe('child3');
  });

  test('preserves all node styles after reorder', () => {
    const before = snapshotNodes(FLEX_PAGE);
    const result = reorderNodeInCode(FLEX_PAGE, 'child1', 'root', 2);
    const after = snapshotNodes(result);

    // All node styles/text should be preserved
    expect(after.child1.styles).toEqual(before.child1.styles);
    expect(after.child1.text).toEqual(before.child1.text);
    expect(after.child2.styles).toEqual(before.child2.styles);
    expect(after.child3.styles).toEqual(before.child3.styles);
  });

  test('reorder in complex page preserves unrelated nodes', () => {
    const before = snapshotNodes(COMPLEX);
    const result = reorderNodeInCode(COMPLEX, 'card1', 'features', 1);
    const after = snapshotNodes(result);

    // hero and its children should be completely unchanged
    assertUnchangedExcept(before, after, ['card1', 'card2', 'features']);
  });

  // ─── Expression-aware reorder (layout {children} slot) ─────────────────
  // Expressions like {children} occupy a visual slot on the canvas (placeholder).
  // reorderNodeInCode must count JSXExpressionContainer as slots, not just JSXElements.

  test('reorder counts {children} expression as a slot', () => {
    const layout = `<div data-id="layout-root" style={{display: 'flex', flexDirection: 'column'}}>
  <nav data-id="navbar" style={{height: '60px'}}>Nav</nav>
  {children}
  <footer data-id="footer" style={{height: '40px'}}>Foot</footer>
</div>`;
    // Move footer to index 0 (before navbar)
    const result = reorderNodeInCode(layout, 'footer', 'layout-root', 0);
    // footer should now be before navbar and {children}
    expect(result.indexOf('data-id="footer"')).toBeLessThan(result.indexOf('data-id="navbar"'));
    expect(result).toContain('{children}');
  });

  test('reorder preserves {children} expression in layout', () => {
    const layout = `<div data-id="layout-root" style={{display: 'flex', flexDirection: 'column'}}>
  <nav data-id="navbar" style={{height: '60px'}}>Nav</nav>
  {children}
  <footer data-id="footer" style={{height: '40px'}}>Foot</footer>
</div>`;
    // Move navbar to index 2 (after {children} and footer)
    const result = reorderNodeInCode(layout, 'navbar', 'layout-root', 2);
    expect(result).toContain('{children}');
    expect(result).toContain('data-id="navbar"');
    expect(result).toContain('data-id="footer"');
    // navbar should be after footer
    expect(result.indexOf('data-id="navbar"')).toBeGreaterThan(result.indexOf('data-id="footer"'));
  });

  // A leading <style> block (no data-id, injected media-query chrome) must NOT
  // consume a reorder slot — otherwise every index is off by one and the move
  // lands one slot short (the "CTA dropped after {children} stays before it" bug).
  test('reorder ignores a leading <style> anchor for slot indexing', () => {
    const layout = `<div data-id="layout-root" style={{display: 'flex', flexDirection: 'column'}}>
  <style>{\`@media (max-width: 375px) { x }\`}</style>
  <footer data-id="footer" style={{height: '40px'}}>Foot</footer>
  <nav data-id="navbar" style={{height: '60px'}}>Nav</nav>
  {children}
</div>`;
    // CTA-style move: send navbar to content index 2 (== after {children}).
    // Content slots (ignoring <style>): [footer, navbar, {children}].
    const result = reorderNodeInCode(layout, 'navbar', 'layout-root', 2);
    // navbar lands AFTER the {children} expression, not before it.
    expect(result.indexOf('data-id="navbar"')).toBeGreaterThan(result.indexOf('{children}'));
    // The <style> anchor stays first and is preserved.
    expect(result).toContain('<style>');
    expect(result.indexOf('<style>')).toBeLessThan(result.indexOf('data-id="footer"'));
    expect(result).toContain('{children}');
  });

  test('reorder keeps a leading <style> anchor at the front after a swap', () => {
    const layout = `<div data-id="layout-root" style={{display: 'flex', flexDirection: 'column'}}>
  <style>{\`@media (max-width: 375px) { x }\`}</style>
  <footer data-id="footer" style={{height: '40px'}}>Foot</footer>
  <nav data-id="navbar" style={{height: '60px'}}>Nav</nav>
  {children}
</div>`;
    // Move footer to content index 1 (after navbar).
    const result = reorderNodeInCode(layout, 'footer', 'layout-root', 1);
    expect(result.indexOf('<style>')).toBeLessThan(result.indexOf('data-id="navbar"'));
    expect(result.indexOf('data-id="footer"')).toBeGreaterThan(result.indexOf('data-id="navbar"'));
  });
});

// ─── moveNodeInCode ────────────────────────────────────────────────────────

describe('moveNodeInCode', () => {
  test('moves node from one parent to another', () => {
    const result = moveNodeInCode(COMPLEX, 'card1', 'hero', { position: 'absolute', left: '10px', top: '10px' });
    const nodes = parseJSXToNodes(result);

    // card1 should now be child of hero
    expect(nodes.get('card1')!.parentId).toBe('hero');
    expect(nodes.get('hero')!.children).toContain('card1');

    // card1 should NOT be child of features anymore
    expect(nodes.get('features')!.children).not.toContain('card1');
  });

  test('move to root (null parent) appends to root element', () => {
    const result = moveNodeInCode(COMPLEX, 'card1', null, { position: 'absolute', left: '500px', top: '600px' });
    const nodes = parseJSXToNodes(result);

    // card1 should now be child of root
    expect(nodes.get('card1')!.parentId).toBe('root');
    expect(nodes.get('root')!.children).toContain('card1');

    // card1 should NOT be child of features
    expect(nodes.get('features')!.children).not.toContain('card1');
  });

  test('updates styles during move', () => {
    const result = moveNodeInCode(COMPLEX, 'card1', null, { position: 'absolute', left: '999px', top: '888px' });
    const nodes = parseJSXToNodes(result);

    expect(nodes.get('card1')!.styles.position).toBe('absolute');
    expect(nodes.get('card1')!.styles.left).toBe('999px');
    expect(nodes.get('card1')!.styles.top).toBe('888px');
  });

  test('preserves moved nodes children', () => {
    const result = moveNodeInCode(COMPLEX, 'card1', 'hero');
    const nodes = parseJSXToNodes(result);

    // card1 should still have its text child
    expect(nodes.get('card1')!.children).toContain('card1-text');
    expect(nodes.get('card1-text')!.parentId).toBe('card1');
  });

  test('preserves unrelated nodes', () => {
    const before = snapshotNodes(COMPLEX);
    const result = moveNodeInCode(COMPLEX, 'card1', 'hero', { position: 'absolute', left: '10px', top: '10px' });
    const after = snapshotNodes(result);

    // title, subtitle, card2 should be unchanged
    expect(after.title).toEqual(before.title);
    expect(after.subtitle).toEqual(before.subtitle);
    expect(after['card2-text']).toEqual(before['card2-text']);
  });

  // ─── Parent-not-found abort (collection-list drag-out data loss, 2026-07-29) ──
  // Before the abort, a move whose target parent wasn't findable in the code
  // (self/descendant drop via a CMS ghost row, ghost-only id, stale id) removed
  // the node in step 1 and then silently DISCARDED it — the node vanished from
  // the file entirely. The move must be refused with the tree left intact.

  test('move into own DESCENDANT is refused — node and subtree preserved', () => {
    const result = moveNodeInCode(COMPLEX, 'features', 'card1');
    const nodes = parseJSXToNodes(result);
    expect(nodes.get('features')!.parentId).toBe('root');
    expect(nodes.get('features')!.children).toContain('card1');
    expect(nodes.get('card1')!.parentId).toBe('features');
    expect(nodes.get('card1')!.children).toContain('card1-text');
  });

  test('move to itself is refused — node preserved', () => {
    const result = moveNodeInCode(COMPLEX, 'card1', 'card1');
    const nodes = parseJSXToNodes(result);
    expect(nodes.get('card1')!.parentId).toBe('features');
    expect(nodes.get('card1')!.children).toContain('card1-text');
  });

  test('move to a NONEXISTENT parent is refused — node preserved, styleChanges kept', () => {
    const result = moveNodeInCode(COMPLEX, 'card1', 'ghost-row-does-not-exist', { left: '42px' });
    const nodes = parseJSXToNodes(result);
    expect(nodes.get('card1')!.parentId).toBe('features');
    expect(nodes.get('card1')!.children).toContain('card1-text');
    // The style write from the top of moveNodeInCode survives the abort.
    expect(nodes.get('card1')!.styles.left).toBe('42px');
  });

  // ─── Expression-aware move (layout {children} slot) ──────────────────────
  // moveNodeInCode must count JSXExpressionContainer when computing insert position.

  test('move with insertIndex counts {children} expression as a slot', () => {
    // sidebar is inside the layout-root but needs to move to a different index
    const layout = `<div data-id="layout-root" style={{display: 'flex', flexDirection: 'column'}}>
  <nav data-id="navbar" style={{height: '60px'}}>Nav</nav>
  {children}
  <footer data-id="footer" style={{height: '40px'}}>Foot</footer>
  <div data-id="sidebar" style={{position: 'absolute', width: '200px'}}>Side</div>
</div>`;
    // Move sidebar to index 2 (after navbar=0 and {children}=1, before footer=2)
    const result = moveNodeInCode(layout, 'sidebar', 'layout-root', undefined, 2, false);
    // sidebar should be inside layout-root
    expect(result).toContain('data-id="sidebar"');
    expect(result).toContain('{children}');
    // sidebar should appear before footer
    expect(result.indexOf('data-id="sidebar"')).toBeLessThan(result.indexOf('data-id="footer"'));
    // sidebar should appear after {children}
    expect(result.indexOf('data-id="sidebar"')).toBeGreaterThan(result.indexOf('{children}'));
  });

  test('move preserves {children} in layout target', () => {
    // banner is at the bottom of layout-root, move to first position
    const layout = `<div data-id="layout-root" style={{display: 'flex', flexDirection: 'column'}}>
  <nav data-id="navbar" style={{height: '60px'}}>Nav</nav>
  {children}
  <footer data-id="footer" style={{height: '40px'}}>Foot</footer>
  <div data-id="banner" style={{width: '100%'}}>Banner</div>
</div>`;
    // Move banner to index 0 (before everything)
    const result = moveNodeInCode(layout, 'banner', 'layout-root', undefined, 0, false);
    expect(result).toContain('{children}');
    expect(result).toContain('data-id="banner"');
    // banner should be before navbar
    expect(result.indexOf('data-id="banner"')).toBeLessThan(result.indexOf('data-id="navbar"'));
  });
});

// ─── updateNodeTextInCode ──────────────────────────────────────────────────

describe('updateNodeTextInCode', () => {
  test('updates plain text content', () => {
    const code = `<p data-id="text" style={{fontSize: '16px'}}>Old text</p>`;
    const result = updateNodeTextInCode(code, 'text', 'New text');
    const nodes = parseJSXToNodes(result);
    expect(nodes.get('text')!.textContent).toBe('New text');
  });

  test('preserves styles when updating text', () => {
    const code = `<p data-id="text" style={{fontSize: '16px', color: '#fff'}}>Old text</p>`;
    const before = snapshotNodes(code);
    const result = updateNodeTextInCode(code, 'text', 'New text');
    const after = snapshotNodes(result);

    expect(after.text.styles).toEqual(before.text.styles);
  });

  test('preserves a user trailing space through the write→read round-trip (the Time - bug)', () => {
    const code = `<p data-id="text" style={{fontSize: '16px'}}>Time</p>`;
    const result = updateNodeTextInCode(code, 'text', 'Time - ');
    expect(parseJSXToNodes(result).get('text')!.textContent).toBe('Time - ');
  });

  test('preserves a user leading space through the round-trip', () => {
    const code = `<p data-id="text">x</p>`;
    const result = updateNodeTextInCode(code, 'text', '  Local /');
    expect(parseJSXToNodes(result).get('text')!.textContent).toBe('  Local /');
  });

  test('a re-edit of already-committed spaced text keeps the space (idempotent)', () => {
    const code = `<p data-id="text">Time - </p>`;
    const once = updateNodeTextInCode(code, 'text', 'Time - ');
    expect(parseJSXToNodes(once).get('text')!.textContent).toBe('Time - ');
  });
});

// ─── addNodeInCode ─────────────────────────────────────────────────────────

describe('addNodeInCode', () => {
  test('adds a child div to root', () => {
    const code = `<div data-id="root" style={{position: 'relative', width: '1440px'}}></div>`;
    const result = addNodeInCode(code, 'root', {
      id: 'frame-1', type: 'div',
      styles: { position: 'absolute', left: '100px', top: '50px', width: '200px', height: '150px' },
    });
    expect(result).toContain('data-id="frame-1"');
    expect(result).toContain("width: '200px'");
    expect(result).toContain("height: '150px'");
  });

  test('adds at specific index', () => {
    const code = `<div data-id="root" style={{position: 'relative'}}>
  <div data-id="a" style={{}}></div>
  <div data-id="b" style={{}}></div>
</div>`;
    const result = addNodeInCode(code, 'root', {
      id: 'frame-1', type: 'div', styles: { position: 'relative' },
    }, 1);
    const aIdx = result.indexOf('data-id="a"');
    const newIdx = result.indexOf('data-id="frame-1"');
    const bIdx = result.indexOf('data-id="b"');
    expect(newIdx).toBeGreaterThan(aIdx);
    expect(newIdx).toBeLessThan(bIdx);
  });

  test('adds with data-name attribute', () => {
    const code = `<div data-id="root" style={{}}></div>`;
    const result = addNodeInCode(code, 'root', {
      id: 'f1', type: 'div', styles: { width: '100px' }, name: 'My Frame',
    });
    expect(result).toContain('data-name="My Frame"');
  });

  test('appends as last child when no index', () => {
    const code = `<div data-id="root" style={{}}>
  <div data-id="a" style={{}}></div>
</div>`;
    const result = addNodeInCode(code, 'root', {
      id: 'f1', type: 'div', styles: {},
    });
    const aIdx = result.indexOf('data-id="a"');
    const newIdx = result.indexOf('data-id="f1"');
    expect(newIdx).toBeGreaterThan(aIdx);
  });

  test('handles display none for replica viewport', () => {
    const code = `<div data-id="root" style={{}}></div>`;
    const result = addNodeInCode(code, 'root', {
      id: 'f1', type: 'div', styles: { display: 'none', width: '100px', height: '100px' },
    });
    expect(result).toContain("display: 'none'");
  });

  // Component files get motion.* wrapping for FLIP between variants. The
  // `motion` proxy from framer-motion only knows HTML tag names — using
  // `motion.MyCard` evaluates to undefined at runtime and breaks JSX. So
  // when adding a child whose type is a component instance (uppercase
  // first letter), the generator must NOT inject the motion. prefix.
  test('does NOT prefix motion. on component-instance tags inside a component file', () => {
    // Component-file marker: presence of `withResponsiveProps`. Triggers
    // the motion.* wrap path in `addNodeInCode`'s isComponentFile branch.
    const code = `import { withResponsiveProps } from '@revyme/runtime';
function Card({ style }) {
  return <div data-id="root" style={{ ...style }}></div>;
}
export default withResponsiveProps(Card);`;
    const result = addNodeInCode(code, 'root', {
      id: 'lib-1', type: 'LiBaVi', styles: { position: 'absolute', left: '0', top: '0' },
    });
    // The added tag MUST be the bare component name, not `motion.LiBaVi`.
    expect(result).toContain('<LiBaVi ');
    expect(result).not.toContain('<motion.LiBaVi');
    expect(result).not.toContain('motion.LiBaVi');
    // And it should NOT carry the layout={true} prop (only HTML motion.*
    // tags inside a component file get the FLIP wiring).
    const tagBlock = result.slice(result.indexOf('<LiBaVi '));
    expect(tagBlock.slice(0, tagBlock.indexOf('>'))).not.toContain('layout={true}');
  });

  test('still prefixes motion. on plain HTML tags inside a component file', () => {
    const code = `import { withResponsiveProps } from '@revyme/runtime';
function Card({ style }) {
  return <div data-id="root" style={{ ...style }}></div>;
}
export default withResponsiveProps(Card);`;
    const result = addNodeInCode(code, 'root', {
      id: 'box-1', type: 'div', styles: { width: '100px' },
    });
    expect(result).toContain('<motion.div');
    expect(result).toContain('layout={true}');
  });
});

// ─── copyContainerRulesToNewWidth ──────────────────────────────────────────

describe('copyContainerRulesToNewWidth', () => {
  // Set up viewport widths so getSortedBreakpointWidths() returns predictable values.
  // Default viewports: desktop=1440, tablet=768, mobile=375 → sorted desc: [1440, 768, 375]
  beforeEach(() => {
    syncViewportWidths({ desktop: 1440, tablet: 768, mobile: 375 });
  });

  const CODE_WITH_STYLE = `<div data-id="root" style={{position: 'relative', width: '1440px'}}>
  <style>{\`
    @media (max-width: 768px) and (min-width: 376.02px) {
      [data-id="box"] { width: 100% !important; font-size: 14px !important; }
    }
  \`}</style>
  <div data-id="box" style={{position: 'absolute', left: '10px', top: '20px', width: '300px'}}></div>
</div>`;

  const CODE_NO_STYLE = `<div data-id="root" style={{position: 'relative', width: '1440px'}}>
  <div data-id="box" style={{position: 'absolute', left: '10px', top: '20px', width: '300px'}}></div>
</div>`;

  const CODE_WITH_MULTIPLE_RULES = `<div data-id="root" style={{position: 'relative', width: '1440px'}}>
  <style>{\`
    @media (max-width: 768px) and (min-width: 376.02px) {
      [data-id="box"] { width: 100% !important; }
      [data-id="title"] { font-size: 24px !important; }
    }
    @media (max-width: 375px) {
      [data-id="box"] { width: 50% !important; }
    }
  \`}</style>
  <div data-id="box" style={{width: '300px'}}></div>
  <p data-id="title" style={{fontSize: '48px'}}>Hello</p>
</div>`;

  test('same source/new width returns unchanged', () => {
    const result = copyContainerRulesToNewWidth(CODE_WITH_STYLE, 768, 768);
    expect(result).toBe(CODE_WITH_STYLE);
  });

  test('no style block returns unchanged', () => {
    const result = copyContainerRulesToNewWidth(CODE_NO_STYLE, 768, 375);
    expect(result).toBe(CODE_NO_STYLE);
  });

  test('no rules at source width returns unchanged', () => {
    // Source width 1440 has no @media rules (1440 is desktop/primary)
    const result = copyContainerRulesToNewWidth(CODE_WITH_STYLE, 1440, 375);
    expect(result).toBe(CODE_WITH_STYLE);
  });

  test('copies rules from source to new width (basic case)', () => {
    // Copy tablet (768) rules to mobile (375)
    const result = copyContainerRulesToNewWidth(CODE_WITH_STYLE, 768, 375);

    // The output should contain a @media rule for 375px with the copied props
    expect(result).toContain('@media (max-width: 375px)');
    expect(result).toContain('[data-id="box"]');
    // The 375px rule should have the copied properties
    expect(result).toContain('width: 100% !important;');
    expect(result).toContain('font-size: 14px !important;');

    // The original 768px rule should still be present
    expect(result).toContain('@media (max-width: 768px)');
  });

  test('merges with existing rules at new width', () => {
    // CODE_WITH_MULTIPLE_RULES has:
    //   768px: box { width: 100% }, title { font-size: 24px }
    //   375px: box { width: 50% }
    // Copy 768 → 375 should merge: box gets width from 768 (overwriting 50%), title gets font-size from 768
    const result = copyContainerRulesToNewWidth(CODE_WITH_MULTIPLE_RULES, 768, 375);

    // 375px rule should now have title (copied from 768)
    expect(result).toContain('@media (max-width: 375px)');
    // box's width should be overwritten by the source's 100%
    expect(result).toMatch(/max-width: 375px[\s\S]*?\[data-id="box"\].*width: 100% !important/);
    // title should be copied to 375px
    expect(result).toMatch(/max-width: 375px[\s\S]*?\[data-id="title"\].*font-size: 24px !important/);
  });

  test('re-serializes with correct min-width boundaries', () => {
    // Viewports: 1440, 768, 375 (sorted desc)
    // For width 768: next smaller is 375 — INCLUSIVE bound (fractional
    // viewport widths like 375.3px fell in the old (375, 376) gap and
    // rendered the desktop base; overlap at exactly 375 is resolved by
    // descending band order — the mobile block comes later and wins).
    // For width 375: it's the smallest, no min-width
    const result = copyContainerRulesToNewWidth(CODE_WITH_STYLE, 768, 375);

    // 768px rule should have the INCLUSIVE min-width: 375.02px
    expect(result).toContain('@media (max-width: 768px) and (min-width: 375.02px)');
    // 375px rule should NOT have min-width (it's the smallest breakpoint)
    expect(result).toMatch(/@media \(max-width: 375px\)\s*\{/);
    // Verify 375px rule does not include "and (min-width:"
    const match375 = result.match(/@media \(max-width: 375px\)([^{]*)\{/);
    expect(match375).not.toBeNull();
    expect(match375![1]).not.toContain('min-width');
  });
});

// ─── updateHoverStyleInCode ──────────────────────────────────────────────────

describe('updateHoverStyleInCode', () => {
  const CODE_WITH_STYLE = `<div data-id="root" style={{position: 'relative', width: '1440px'}}>
  <style>{\`
    .some-rule { color: red; }
  \`}</style>
  <div data-id="box" style={{position: 'absolute', left: '10px', top: '20px', width: '100px', height: '50px'}}></div>
</div>`;

  const CODE_NO_STYLE = `<div data-id="root" style={{position: 'relative', width: '1440px'}}>
  <div data-id="box" style={{position: 'absolute', left: '10px', top: '20px', width: '100px', height: '50px'}}></div>
</div>`;

  test('creates hover rule when style block exists', () => {
    const result = updateHoverStyleInCode(CODE_WITH_STYLE, 'box', { backgroundColor: '#ff0000', opacity: '0.8' });
    expect(result).toContain('[data-id="box"]:hover');
    expect(result).toContain('background-color: #ff0000 !important;');
    expect(result).toContain('opacity: 0.8 !important;');
    // Existing CSS should be preserved
    expect(result).toContain('.some-rule { color: red; }');
  });

  test('creates hover rule when no style block exists', () => {
    const result = updateHoverStyleInCode(CODE_NO_STYLE, 'box', { backgroundColor: '#ff0000' });
    expect(result).toContain('<style>');
    expect(result).toContain('[data-id="box"]:hover');
    expect(result).toContain('background-color: #ff0000 !important;');
  });

  test('updates existing hover rule', () => {
    // First create a hover rule
    const step1 = updateHoverStyleInCode(CODE_WITH_STYLE, 'box', { backgroundColor: '#ff0000' });
    expect(step1).toContain('background-color: #ff0000 !important;');

    // Now update it with different styles
    const step2 = updateHoverStyleInCode(step1, 'box', { backgroundColor: '#00ff00', opacity: '0.5' });
    expect(step2).toContain('background-color: #00ff00 !important;');
    expect(step2).toContain('opacity: 0.5 !important;');
    // Old value should be gone
    expect(step2).not.toContain('#ff0000');
    // Should only have one :hover rule for this node
    const hoverMatches = step2.match(/\[data-id="box"\]:hover/g);
    expect(hoverMatches).toHaveLength(1);
  });

  test('removes individual property (empty string value)', () => {
    // Create a rule with two properties
    const step1 = updateHoverStyleInCode(CODE_WITH_STYLE, 'box', { backgroundColor: '#ff0000', opacity: '0.8' });
    expect(step1).toContain('background-color: #ff0000 !important;');
    expect(step1).toContain('opacity: 0.8 !important;');

    // Remove opacity by passing empty string, keep backgroundColor
    const step2 = updateHoverStyleInCode(step1, 'box', { backgroundColor: '#ff0000', opacity: '' });
    expect(step2).toContain('background-color: #ff0000 !important;');
    expect(step2).not.toContain('opacity');
  });

  test('removes entire rule when all properties empty', () => {
    // Create a rule
    const step1 = updateHoverStyleInCode(CODE_WITH_STYLE, 'box', { backgroundColor: '#ff0000' });
    expect(step1).toContain('[data-id="box"]:hover');

    // Remove all properties
    const step2 = updateHoverStyleInCode(step1, 'box', { backgroundColor: '' });
    expect(step2).not.toContain('[data-id="box"]:hover');
    // Style block should still exist
    expect(step2).toContain('<style>');
  });

  test('removeHoverStyleInCode removes the rule', () => {
    // Create a rule first
    const step1 = updateHoverStyleInCode(CODE_WITH_STYLE, 'box', { backgroundColor: '#ff0000', opacity: '0.8' });
    expect(step1).toContain('[data-id="box"]:hover');

    // Remove it
    const step2 = removeHoverStyleInCode(step1, 'box');
    expect(step2).not.toContain('[data-id="box"]:hover');
    // Style block and other rules should remain
    expect(step2).toContain('<style>');
    expect(step2).toContain('.some-rule { color: red; }');
  });
});

// ─── updatePseudoStyleInCode ────────────────────────────────────────────────

describe('updatePseudoStyleInCode', () => {
  const CODE_WITH_STYLE = `<div data-id="root" style={{position: 'relative', width: '1440px'}}>
  <style>{\`
    [data-id="root"]:hover { opacity: 0.5 !important; }
  \`}</style>
  <h1 data-id="title">Hello</h1>
</div>`;

  const CODE_NO_STYLE = `<div data-id="root" style={{position: 'relative', width: '100%'}}>
  <h1 data-id="title">Hello</h1>
</div>`;

  test('adds ::before rule to existing style block', () => {
    const result = updatePseudoStyleInCode(CODE_WITH_STYLE, 'title', 'before', { content: "''", position: 'absolute', color: '#FF0033' });
    expect(result).toContain('[data-id="title"]::before');
    expect(result).toContain("content: '' !important");
    expect(result).toContain('color: #FF0033 !important');
    // Existing CSS should be preserved
    expect(result).toContain('[data-id="root"]:hover');
  });

  test('adds ::after rule to existing style block', () => {
    const result = updatePseudoStyleInCode(CODE_WITH_STYLE, 'title', 'after', { content: "''", opacity: '0.5' });
    expect(result).toContain('[data-id="title"]::after');
    expect(result).toContain('opacity: 0.5 !important');
  });

  test('creates style block when none exists', () => {
    const result = updatePseudoStyleInCode(CODE_NO_STYLE, 'title', 'before', { content: "''", color: 'red' });
    expect(result).toContain('<style>');
    expect(result).toContain('[data-id="title"]::before');
  });

  test('updates existing ::before rule', () => {
    const step1 = updatePseudoStyleInCode(CODE_WITH_STYLE, 'title', 'before', { content: "''", color: '#FF0033' });
    const step2 = updatePseudoStyleInCode(step1, 'title', 'before', { content: "''", color: '#00FF00', opacity: '0.5' });
    expect(step2).toContain('color: #00FF00 !important');
    expect(step2).toContain('opacity: 0.5 !important');
    expect(step2).not.toContain('#FF0033');
    // Should only have one ::before rule
    const matches = step2.match(/\[data-id="title"\]::before/g);
    expect(matches).toHaveLength(1);
  });

  test('removes rule when all values empty', () => {
    const step1 = updatePseudoStyleInCode(CODE_WITH_STYLE, 'title', 'before', { content: "''", color: '#FF0033' });
    expect(step1).toContain('[data-id="title"]::before');
    const step2 = updatePseudoStyleInCode(step1, 'title', 'before', {});
    expect(step2).not.toContain('[data-id="title"]::before');
  });

  test('removePseudoStyleInCode removes the rule', () => {
    const step1 = updatePseudoStyleInCode(CODE_WITH_STYLE, 'title', 'before', { content: "''", color: '#FF0033' });
    expect(step1).toContain('[data-id="title"]::before');
    const step2 = removePseudoStyleInCode(step1, 'title', 'before');
    expect(step2).not.toContain('[data-id="title"]::before');
    // Other rules should remain
    expect(step2).toContain('<style>');
    expect(step2).toContain('[data-id="root"]:hover');
  });

  test('handles animation shorthand', () => {
    const result = updatePseudoStyleInCode(CODE_WITH_STYLE, 'title', 'before', { animation: 'glitch 3s infinite linear alternate-reverse' });
    expect(result).toContain('animation: glitch 3s infinite linear alternate-reverse !important');
  });
});

// ─── AST path: SpreadElement handling ───────────────────────────────────────

describe('updateNodeInCode AST path: SpreadElement', () => {
  test('adds new property BEFORE spread element', () => {
    // Component root with ...style spread — adding a new prop must go BEFORE the spread
    const code = `<div data-id="hero" style={{position: 'relative', width: '320px', ...style}}>Hello</div>`;
    const result = updateNodeInCode(code, 'hero', { backgroundColor: '#ff0000' });
    const nodes = parseJSXToNodes(result);
    expect(nodes.get('hero')!.styles.backgroundColor).toBe('#ff0000');
    // ...style must still be in the output (Babel generates it)
    expect(result).toContain('...style');
    // The new property should appear BEFORE ...style in the source
    const bgIdx = result.indexOf('backgroundColor');
    const spreadIdx = result.indexOf('...style');
    expect(bgIdx).toBeGreaterThan(-1);
    expect(spreadIdx).toBeGreaterThan(-1);
    expect(bgIdx).toBeLessThan(spreadIdx);
  });

  test('keeps spread at end after modifying existing property', () => {
    const code = `<div data-id="hero" style={{position: 'relative', width: '320px', ...style}}>Hello</div>`;
    const result = updateNodeInCode(code, 'hero', { width: '500px' });
    const nodes = parseJSXToNodes(result);
    expect(nodes.get('hero')!.styles.width).toBe('500px');
    // Spread must remain last
    const widthIdx = result.indexOf("width:");
    const spreadIdx = result.indexOf('...style');
    expect(spreadIdx).toBeGreaterThan(widthIdx);
  });

  test('creates style attribute on element without one', () => {
    // Component tag with no style attribute — AST path creates style={{}}
    const code = `<div data-id="card" data-name="Card">Content</div>`;
    const result = updateNodeInCode(code, 'card', { width: '400px' });
    const nodes = parseJSXToNodes(result);
    expect(nodes.get('card')!.styles.width).toBe('400px');
    expect(result).toContain('style=');
  });

  test('handles both single and double quoted data-id values', () => {
    // Single quotes
    const codeSingle = `<div data-id='box' style={{width: '100px'}}>Text</div>`;
    const resultSingle = updateNodeInCode(codeSingle, 'box', { height: '50px' });
    const nodesSingle = parseJSXToNodes(resultSingle);
    expect(nodesSingle.get('box')!.styles.height).toBe('50px');
    expect(nodesSingle.get('box')!.styles.width).toBe('100px');

    // Double quotes (standard)
    const codeDouble = `<div data-id="box" style={{width: '100px'}}>Text</div>`;
    const resultDouble = updateNodeInCode(codeDouble, 'box', { height: '50px' });
    const nodesDouble = parseJSXToNodes(resultDouble);
    expect(nodesDouble.get('box')!.styles.height).toBe('50px');
    expect(nodesDouble.get('box')!.styles.width).toBe('100px');
  });

  test('removing property preserves spread at end', () => {
    const code = `<div data-id="hero" style={{position: 'relative', width: '320px', backgroundColor: 'red', ...style}}>Hello</div>`;
    const result = updateNodeInCode(code, 'hero', { backgroundColor: '' });
    const nodes = parseJSXToNodes(result);
    expect(nodes.get('hero')!.styles.backgroundColor).toBeUndefined();
    expect(nodes.get('hero')!.styles.position).toBe('relative');
    expect(nodes.get('hero')!.styles.width).toBe('320px');
    // Spread still at end
    expect(result).toContain('...style');
  });

  test('adding multiple new properties keeps spread last', () => {
    const code = `<div data-id="root" style={{display: 'flex', ...style}}>Hello</div>`;
    const result = updateNodeInCode(code, 'root', { gap: '20px', padding: '16px' });
    const nodes = parseJSXToNodes(result);
    expect(nodes.get('root')!.styles.gap).toBe('20px');
    expect(nodes.get('root')!.styles.padding).toBe('16px');
    expect(nodes.get('root')!.styles.display).toBe('flex');
    // Spread is last
    const spreadIdx = result.indexOf('...style');
    const gapIdx = result.indexOf('gap');
    const paddingIdx = result.indexOf('padding');
    expect(spreadIdx).toBeGreaterThan(gapIdx);
    expect(spreadIdx).toBeGreaterThan(paddingIdx);
  });
});

describe('updateNodeChildrenFromHTML — partial-selection font span never wipes text', () => {
  const CODE = `export default function Page() {
  return <div data-id="root">
    <h1 data-id="t">Every money tool you need, in one place</h1>
  </div>;
}`;

  test('quoted font family in a span keeps the text AND the span style', () => {
    // The exact bug: a partial selection styled with a quoted font family
    // (`'Playfair Display', serif`) produced invalid JSX → silent parse-null →
    // empty <h1>. Must keep the text and the per-span fontFamily.
    const html = `Every money tool you need, in <span style="font-family: 'Playfair Display', serif">one place</span>`;
    const out = updateNodeChildrenFromHTML(CODE, 't', html);
    expect(out).toMatch(/Every money tool you need, in/);
    expect(out).toMatch(/one place/);
    expect(out).toMatch(/fontFamily:/);
    expect(out).toMatch(/Playfair Display/);
  });

  test('plain (unquoted) font span also round-trips', () => {
    const html = `Every money <span style="font-family: Inter, sans-serif">tool</span> you need`;
    const out = updateNodeChildrenFromHTML(CODE, 't', html);
    expect(out).toMatch(/Every money/);
    expect(out).toMatch(/tool/);
    expect(out).toMatch(/you need/);
    expect(out).toMatch(/fontFamily: 'Inter, sans-serif'/);
  });
});

// The DOUBLING bug (live find 2026-07-24): a rich-text node wraps its text in a
// single `<span>`. On commit TipTap collapses the uniform span to bare text, so
// the plain (no-tag) HTML lands. The old code routed that to updateNodeTextInCode,
// which PRESERVES element children + only swaps the first bare JSXText — a span-
// wrapped node has none, so it APPENDED → `<span>OLD</span>NEW`.
describe('updateNodeChildrenFromHTML — plain text fully replaces a <span> wrapper (no doubling)', () => {
  const spanCode = (inner: string) => `export default function Page() {
  return <div data-id="root">
    <p data-id="t" data-name="Text">${inner}</p>
  </div>;
}`;

  test('plain commit onto a single-span node yields the text ONCE', () => {
    const CODE = spanCode('<span>Save more and get visibility on your money</span>');
    const out = updateNodeChildrenFromHTML(CODE, 't', 'Save more and get visibility on your money');
    // Exactly one occurrence — not doubled.
    const occurrences = (out.match(/Save more and get visibility on your money/g) ?? []).length;
    expect(occurrences).toBe(1);
    // The old <span> wrapper is gone.
    expect(out).not.toMatch(/<span>/);
  });

  test('editing the text of a span node replaces (not appends) it', () => {
    const CODE = spanCode('<span>Old text</span>');
    const out = updateNodeChildrenFromHTML(CODE, 't', 'Brand new text');
    expect(out).toMatch(/Brand new text/);
    expect(out).not.toMatch(/Old text/);   // fully replaced
    expect(out).not.toMatch(/<span>/);
  });

  test('plain commit onto a bare-text node still works (unchanged behavior)', () => {
    const CODE = spanCode('Old plain');
    const out = updateNodeChildrenFromHTML(CODE, 't', 'New plain');
    expect(out).toMatch(/New plain/);
    expect(out).not.toMatch(/Old plain/);
    const occurrences = (out.match(/New plain/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  test('trailing edge space survives the plain-text round-trip (inline JSXText)', () => {
    const CODE = spanCode('<span>Time</span>');
    const out = updateNodeChildrenFromHTML(CODE, 't', 'Time - ');
    // The generator writes it inline so the trailing space isn't stripped at a line edge.
    expect(out).toMatch(/Time - /);
  });
});
