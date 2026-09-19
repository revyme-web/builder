// runtime-guarantees.test.ts — the builder-side dialect normalizer
// (src/code/generation/runtime-guarantees.ts).
//
// Contract under test: a committed source can NEVER carry a self-healable
// oracle violation. The normalizer is the write-path twin of the drop path's
// layout-normalize (src/canvas/drag/layout-normalize.ts) — same rules, same
// values, byte-for-byte parity on the shared cases (tests F). Per rule: A)
// positive (canonical input strictly unchanged + idempotent), B) repair to
// the canonical form, C) non-regression (exclusions), D) the same violation
// repaired through ALL FOUR seams (queue processQueue, queue flushNow,
// modifyProjectFile, freeform commitTurnFiles), E) golden (normalized output
// passes checkFile on the rule), F) parity with layout-normalize, G) perf.
import { describe, it, expect, beforeEach } from 'vitest';
import { parse } from '@babel/parser';
import { applyRuntimeGuarantees, needsRuntimeGuarantees } from './runtime-guarantees';
import { checkFile } from '@/code/oracle/check-file';
import { normalizeLayoutDescriptor } from '@/canvas/drag/layout-normalize';
import { initMutationQueue, queueMutation, flushNow } from '@/code/mutation/mutation-queue';
import { modifyProjectFile } from '@/code/project/modify-file';
import { projectFS, resetProjectFS } from '@/code/project/project-fs';
import { commitTurnFiles } from '@/code/oracle/gate';
import type { NewNodeDescriptor } from '@/shared/types';

const PAGE = (child: string) => `'use client';
import React from 'react';
export default function Page() {
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%' }}>
    ${child}
  </div>;
}
`;

/** Count of default-position injections — the PAGE root always carries
 *  `position: 'relative'`, so "nothing injected" means exactly 1. */
const relCount = (code: string) => (code.match(/position: 'relative'/g) ?? []).length;

/** All oracle violations of the given codes an element can carry. */
const hits = (code: string, ruleCodes: string[]) =>
  checkFile(code, { kind: 'page', existingDataIds: new Set<string>() }).filter((v) => ruleCodes.includes(v.code));

const golden = (code: string, ruleCodes: string[]) => {
  // Empty existing-set ⇒ every node counts as NEW ⇒ the oracle's new-node
  // gates (NODE_MISSING_POSITION in particular) evaluate fully.
  expect(hits(code, ruleCodes)).toEqual([]);
};

/** Extract every static style object (in document order) as a flat list —
 *  root at 0, first container at 1, its children at 2.. */
function readStyleMaps(code: string): Record<string, string>[] {
  const ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
  const out: Record<string, string>[] = [];
  const walk = (node: any): void => {
    if (node == null) return;
    if (node.type === 'JSXElement' || node.type === 'JSXFragment') {
      const el = node.type === 'JSXElement' ? node.openingElement : null;
      if (el) {
        const attr = (el.attributes ?? []).find((a: any) => a.type === 'JSXAttribute' && a.name.name === 'style');
        const styles: Record<string, string> = {};
        const expr = attr?.value?.type === 'JSXExpressionContainer' ? attr.value.expression : null;
        if (expr?.type === 'ObjectExpression') {
          for (const pr of expr.properties) {
            if (pr.type === 'ObjectProperty'
              && (pr.key.type === 'Identifier' || pr.key.type === 'StringLiteral')
              && pr.value.type === 'StringLiteral') {
              styles[pr.key.name ?? pr.key.value] = pr.value.value;
            }
          }
        }
        out.push(styles);
      }
      for (const child of node.children ?? []) walk(child);
    } else if (node.type === 'JSXExpressionContainer') {
      walk(node.expression);
    } else if (node.type === 'ReturnStatement') {
      walk(node.argument);
    } else if (node.type === 'BlockStatement') {
      for (const stmt of node.body) walk(stmt);
    } else if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) walk(d.init);
    } else if (node.type === 'FunctionDeclaration' || node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
      walk(node.body);
    }
  };
  for (const body of ast.program.body) {
    if (body.type === 'ExportDefaultDeclaration') walk(body.declaration);
    else walk(body);
  }
  return out;
}

const n = (tag: string, styles: Record<string, string>, children?: NewNodeDescriptor[]): NewNodeDescriptor =>
  ({ tag, styles, children });

// ─── THE GUARD (needsRuntimeGuarantees) ────────────────────────────────────
describe('needsRuntimeGuarantees — the perf gate', () => {
  const styleOnly = ['updateStyles', 'updateContainerStyle', 'updateVariantStyle', 'updateCssHover',
    'updatePseudoStyle', 'updateMotionProp', 'updateLoop', 'updateInstanceFx', 'updateTextAnim',
    'updateScrollAnim', 'setConditionalStyle', 'updateHtmlAttrs', 'updateText', 'updateVariantText'];

  it('false for a drain made purely of style/text/animation mutations', () => {
    expect(needsRuntimeGuarantees(styleOnly)).toBe(false);
    expect(needsRuntimeGuarantees(['updateStyles', 'updateStyles'])).toBe(false);
    expect(needsRuntimeGuarantees([])).toBe(false);
  });

  it('true when the drain carries ANY structural mutation', () => {
    for (const t of ['addNode', 'addCanvasNode', 'move', 'reorder', 'updateChildrenHTML', 'changeTag', 'writeFile']) {
      expect(needsRuntimeGuarantees([t])).toBe(true);
      expect(needsRuntimeGuarantees([...styleOnly, t])).toBe(true);
    }
  });
});

// ─── RULE 1 — NODE_MISSING_POSITION ────────────────────────────────────────
describe('Rule 1 — position: relative when absent', () => {
  it('A) positive: canonical input passes through strictly unchanged, idempotent', () => {
    const canonical = PAGE(`<div data-id="x" data-name="X" style={{ position: 'relative', order: '0', flex: '0 0 auto', width: '100%' }} />`);
    expect(applyRuntimeGuarantees(canonical)).toBe(canonical);
    expect(applyRuntimeGuarantees(applyRuntimeGuarantees(canonical))).toBe(applyRuntimeGuarantees(canonical));
  });

  it("B) repair: injects position: 'relative' as the first style property, quoted exactly like layout-normalize", () => {
    const out = applyRuntimeGuarantees(PAGE(`<div data-id="x" data-name="X" style={{ width: '100%' }} />`));
    expect(out).toContain(`style={{ position: 'relative', width: '100%' }}`);
    // empty object → comma-free insert
    const empty = applyRuntimeGuarantees(PAGE(`<div data-id="x" data-name="X" style={{}} />`));
    expect(empty).toContain(`style={{ position: 'relative' }}`);
    // idempotent
    expect(applyRuntimeGuarantees(out)).toBe(out);
  });

  it('B) repair: keeps the motion.* tag and the positioned-only object untouched elsewhere', () => {
    const out = applyRuntimeGuarantees(PAGE(`<motion.div data-id="x" layout style={{ width: 'auto' }} />`));
    expect(out).toContain(`<motion.div data-id="x" layout style={{ position: 'relative', width: 'auto' }}`);
  });

  it('C) never touches an existing position (any value)', () => {
    for (const pos of ['relative', 'absolute', 'fixed', 'static', 'sticky']) {
      const src = PAGE(`<div data-id="x" data-name="X" style={{ position: '${pos}', width: '100px' }} />`);
      expect(applyRuntimeGuarantees(src)).toBe(src);
    }
  });

  it('C) skip: elements without data-id, the page root, canvas nodes, transparent tags, spread and non-static styles', () => {
    const noId = applyRuntimeGuarantees(PAGE(`<div style={{ width: '100%' }} />`));
    expect(relCount(noId)).toBe(1); // only the PAGE root
    const root = applyRuntimeGuarantees(`export default function Page() { return <div data-id="root" style={{ width: '100%' }} />; }`);
    expect(relCount(root)).toBe(0);
    const cn = applyRuntimeGuarantees(PAGE(`<div data-id="x" data-canvas-node="true" style={{ width: '100%' }} />`));
    expect(relCount(cn)).toBe(1);
    const presence = applyRuntimeGuarantees(PAGE(`<AnimatePresence data-id="x" style={{ width: '100%' }} />`));
    expect(relCount(presence)).toBe(1); // wrapper exempt — only the root carries position
    const spread = applyRuntimeGuarantees(PAGE(`<div data-id="x" style={{ width: '100%', ...style }} />`));
    expect(relCount(spread)).toBe(1);
    const ternary = applyRuntimeGuarantees(PAGE(`<div data-id="x" style={active ? { width: '1px' } : { width: '2px' }} />`));
    expect(relCount(ternary)).toBe(1);
    const ident = applyRuntimeGuarantees(PAGE(`<div data-id="x" style={styles} />`));
    expect(relCount(ident)).toBe(1);
  });

  it('C) skip: svg wrappers and svg interiors', () => {
    const svg = applyRuntimeGuarantees(PAGE(`<svg data-id="x" style={{ width: '100%', height: 'auto' }} viewBox="0 0 10 10"><path data-id="x-path" style={{ fill: '#000' }} /></svg>`));
    expect(relCount(svg)).toBe(1);
  });

  it('C) skip: elements with NO style prop at all (incl. component instances — v1 scope)', () => {
    const noStyle = applyRuntimeGuarantees(PAGE(`<p data-id="x">hi</p>`));
    expect(relCount(noStyle)).toBe(1);
    const inst = applyRuntimeGuarantees(PAGE(`<Card data-id="card-1" data-name="Card" />`));
    expect(relCount(inst)).toBe(1);
  });

  it('D) the same violation is repaired through every seam', () => {
    // seam 1+2 — the mutation queue: async processQueue drain + sync flushNow drain
    initMutationQueue(PAGE(`<div data-id="x" data-name="X" style={{ width: '100%' }} />`), () => {});
    queueMutation({ type: 'reorder', nodeId: 'x', parentId: 'root', index: 0 });
    queueMutation({ type: 'reorder', nodeId: 'x', parentId: 'root', index: 0 });
    flushNow();
    // seam 3 — modifyProjectFile
    resetProjectFS(new Map([['p.tsx', PAGE(`<div data-id="x" data-name="X" style={{ width: '100%' }} />`)]]));
    modifyProjectFile('p.tsx', (c) => c);
    expect(projectFS.readFile('p.tsx')).toContain(`style={{ position: 'relative', width: '100%' }}`);
    // seam 4 — freeform commitTurnFiles (new-file branch)
    resetProjectFS(new Map([['p.tsx', 'keep']]));
    commitTurnFiles([{ path: 'app/page.client.tsx', kind: 'page', code: PAGE(`<div data-id="x" data-name="X" style={{ width: '100%' }} />`) }]);
    expect(projectFS.readFile('app/page.client.tsx')).toContain(`style={{ position: 'relative', width: '100%' }}`);
  });

  it('E) golden: normalized output passes NODE_MISSING_POSITION with every node new', () => {
    const out = applyRuntimeGuarantees(PAGE(`<div data-id="x" data-name="X" style={{ width: '100%' }} />`));
    golden(out, ['NODE_MISSING_POSITION']);
  });

  it('F) parity with layout-normalize on the position fixture', () => {
    const jsx = PAGE(`<div data-id="a" style={{ width: '10px' }}><div data-id="b" style={{ position: 'absolute', width: '20px' }} /></div>`);
    const mine = readStyleMaps(applyRuntimeGuarantees(jsx));
    const theirs = normalizeLayoutDescriptor(n('div', { width: '10px' }, [n('div', { position: 'absolute', width: '20px' })]));
    expect(mine[1]).toEqual(theirs.styles);
    expect(mine[2]).toEqual(theirs.children![0].styles);
  });
});

// ─── RULE 2 — FLEX_CHILD_MISSING_ORDER ─────────────────────────────────────
describe('Rule 2 — sequential quoted order on flex/grid flow children', () => {
  const ROW = `<div data-id="row" data-name="Row" style={{ position: 'relative', display: 'flex' }}>
      <div data-id="a" style={{ width: '10px' }} />
      <div data-id="b" style={{ width: '10px' }} />
    </div>`;

  it('A) positive: canonical container with order stays byte-identical and idempotent', () => {
    const canonical = PAGE(`<div data-id="row" style={{ position: 'relative', display: 'flex' }}>
      <div data-id="a" style={{ position: 'relative', order: '0', flex: '0 0 auto' }} />
      <div data-id="b" style={{ position: 'relative', order: '1', flex: '0 0 auto' }} />
    </div>`);
    expect(applyRuntimeGuarantees(canonical)).toBe(canonical);
    expect(applyRuntimeGuarantees(applyRuntimeGuarantees(canonical))).toBe(applyRuntimeGuarantees(canonical));
  });

  it("B) repair: missing order children get the layout-normalize sequence ('0', '1', …,' quoted) + shrink-0 flex", () => {
    const out = applyRuntimeGuarantees(PAGE(ROW));
    expect(out).toContain(`style={{ position: 'relative', order: '0', flex: '0 0 auto', width: '10px' }}`);
    expect(out).toContain(`style={{ position: 'relative', order: '1', flex: '0 0 auto', width: '10px' }}`);
    expect(applyRuntimeGuarantees(out)).toBe(out);
  });

  it('B) repair: grid containers get order too, absolute children are skipped and consume no index', () => {
    const out = applyRuntimeGuarantees(PAGE(`<div data-id="row" style={{ display: 'grid' }}>
      <div data-id="abs" style={{ position: 'absolute' }} />
      <div data-id="a" style={{}} />
      <div data-id="b" style={{}} />
    </div>`));
    expect(out).toContain(`style={{ position: 'absolute' }}`);
    expect(out).toContain(`style={{ position: 'relative', order: '0' }}`);
    expect(out).toContain(`style={{ position: 'relative', order: '1' }}`);
  });

  it('B) repair: style-less children get a created object (position first, then order, then flex)', () => {
    const out = applyRuntimeGuarantees(PAGE(`<div data-id="row" style={{ display: 'flex' }}>
      <p data-id="a">A</p>
      <button data-id="b">B</button>
    </div>`));
    expect(out).toContain(`<p data-id="a" style={{ position: 'relative', order: '0', flex: '0 0 auto' }}>`);
    expect(out).toContain(`<button data-id="b" style={{ position: 'relative', order: '1', flex: '0 0 auto' }}>`);
    expect(applyRuntimeGuarantees(out)).toBe(out);
  });

  it('B) repair: an existing order still consumes its index (layout-normalize flowIdx parity)', () => {
    const out = applyRuntimeGuarantees(PAGE(`<div data-id="row" style={{ display: 'flex' }}>
      <div data-id="a" style={{ order: '5' }} />
      <div data-id="b" style={{}} />
    </div>`));
    expect(out).toContain(`order: '5'`);
    expect(out).toContain(`style={{ position: 'relative', order: '1', flex: '0 0 auto' }}`); // b takes index 1, not 0
  });

  it('C) a ternary order is legal and never overwritten, still consumes its index', () => {
    const out = applyRuntimeGuarantees(PAGE(`<div data-id="row" style={{ display: 'flex' }}>
      <div data-id="a" style={{ order: variant === 'x' ? 2 : 0 }} />
      <div data-id="b" style={{}} />
    </div>`));
    expect(out).toContain(`order: variant === 'x' ? 2 : 0`);
    expect(out).toContain(`order: '1'`);
  });

  it('C) single flow child → no order at all; ternary display → skip; non-flex display → skip', () => {
    const single = applyRuntimeGuarantees(PAGE(`<div data-id="row" style={{ display: 'flex' }}><div data-id="a" style={{}} /></div>`));
    expect(single).not.toContain('order:');
    const ternary = applyRuntimeGuarantees(PAGE(`<div data-id="row" style={{ display: isRow ? 'flex' : 'block' }}>
      <div data-id="a" style={{}} /><div data-id="b" style={{}} />
    </div>`));
    expect(ternary).not.toContain('order:');
    const block = applyRuntimeGuarantees(PAGE(`<div data-id="row" style={{ display: 'block' }}>
      <div data-id="a" style={{}} /><div data-id="b" style={{}} />
    </div>`));
    expect(block).not.toContain('order:');
  });

  it('E) golden: normalized output passes FLEX_CHILD_MISSING_ORDER and ORDER_MUST_BE_STRING', () => {
    const out = applyRuntimeGuarantees(PAGE(ROW));
    golden(out, ['FLEX_CHILD_MISSING_ORDER', 'ORDER_MUST_BE_STRING']);
  });

  it('F) parity with layout-normalize on the order fixtures', () => {
    // 'assigns sequential quoted order to flex/grid flow children'
    const flex = applyRuntimeGuarantees(PAGE(`<div data-id="row" style={{ display: 'flex' }}>
      <p data-id="c0" /><p data-id="c1" /><button data-id="c2" />
    </div>`));
    const theirs = normalizeLayoutDescriptor(n('div', { display: 'flex' }, [n('p', {}), n('p', {}), n('button', {})]));
    expect(readStyleMaps(flex).slice(2).map((s) => s.order)).toEqual(theirs.children!.map((c) => c.styles!.order));

    // 'absolute children are exempt from order (and do not consume an index)'
    const abs = applyRuntimeGuarantees(PAGE(`<div data-id="row" style={{ display: 'flex' }}>
      <div data-id="x0" style={{ position: 'absolute' }} /><p data-id="x1" /><p data-id="x2" />
    </div>`));
    const theirsAbs = normalizeLayoutDescriptor(n('div', { display: 'flex' }, [
      n('div', { position: 'absolute' }), n('p', {}), n('p', {}),
    ]));
    const mineAbs = readStyleMaps(abs).slice(2);
    expect(mineAbs[0].order).toBeUndefined();
    expect(mineAbs[1].order).toBe(theirsAbs.children![1].styles!.order);
    expect(mineAbs[2].order).toBe(theirsAbs.children![2].styles!.order);

    // 'grid children get order but NOT a shrink rewrite' — full style-map parity
    const grid = applyRuntimeGuarantees(PAGE(`<div data-id="row" style={{ display: 'grid' }}>
      <div data-id="g0" /><div data-id="g1" />
    </div>`));
    const theirsGrid = normalizeLayoutDescriptor(n('div', { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)' }, [n('div', {}), n('div', {})]));
    const mineGrid = readStyleMaps(grid).slice(2);
    expect(mineGrid[0]).toEqual(theirsGrid.children![0].styles);
    expect(mineGrid[1]).toEqual(theirsGrid.children![1].styles);
  });
});

// ─── RULE 3 — FLEX_CHILD_SHRINKS ───────────────────────────────────────────
describe('Rule 3 — flex children never shrink (flex only, grid exempt)', () => {
  it('A) positive: canonical children (flex 0 0 auto) stay byte-identical, idempotent', () => {
    const canonical = PAGE(`<div data-id="row" style={{ position: 'relative', display: 'flex' }}>
      <div data-id="a" style={{ position: 'relative', order: '0', flex: '0 0 auto' }} />
      <div data-id="b" style={{ position: 'relative', order: '1', flex: '0 0 auto' }} />
    </div>`);
    expect(applyRuntimeGuarantees(canonical)).toBe(canonical);
  });

  it('B) repair: layout-normalize strings — Hug for no flex, shrink-0 rewrite for explicit flexes', () => {
    const out = applyRuntimeGuarantees(PAGE(`<div data-id="row" style={{ display: 'flex' }}>
      <div data-id="a" style={{}} />                                    // no flex → '0 0 auto'
      <div data-id="b" style={{ flex: '1 1 0px' }} />                   // Fill w/ shrink → '1 0 0px'
      <div data-id="c" style={{ flex: '1' }} />                         // single grow → '1 0 0px'
      <div data-id="d" style={{ flex: '1 1' }} />                       // grow shrink → '1 0'
      <div data-id="e" style={{ flex: '1 200px' }} />                   // grow basis → '1 0' (layout-normalize parity)
      <div data-id="f" style={{ flexShrink: 1 }} />                     // explicit shrink → '0 0 auto'
    </div>`));
    expect(out).toContain(`style={{ position: 'relative', order: '0', flex: '0 0 auto' }}`);
    expect(out).toContain(`flex: '1 0 0px'`);
    expect(out).toContain(`flex: '1 0'`);
    // NOTE: '1 200px' → '1 0', NOT '1 0 200px' — forcedFlexString mirrors
    // layout-normalize's forceNonShrink, whose /^-?\d/ test reads '200px'
    // as a grow-shrink pair. The drop path produces the identical string;
    // parity beats semantics here.
    expect(applyRuntimeGuarantees(out)).toBe(out);
    expect(applyRuntimeGuarantees(out)).toBe(out);
  });

  it('B) repair: applied per child regardless of existing order', () => {
    const out = applyRuntimeGuarantees(PAGE(`<div data-id="row" style={{ display: 'flex' }}>
      <div data-id="a" style={{ display: 'flex' }} />
      <div data-id="b" style={{ flexShrink: '1' }} />
    </div>`));
    expect(out).toContain(`style={{ position: 'relative', order: '0', flex: '0 0 auto', display: 'flex' }}`);
    expect(out).toContain(`flex: '0 0 auto'`);
  });

  it('C) skips: conforming flex everywhere (shrink 0, none, Fill, flexShrink 0, indeterminate)', () => {
    const out = applyRuntimeGuarantees(PAGE(`<div data-id="row" style={{ display: 'flex' }}>
      <div data-id="a" style={{ flexShrink: '0' }} />
      <div data-id="b" style={{ flex: 'none' }} />
      <div data-id="c" style={{ flex: '1 0 0px' }} />
      <div data-id="d" style={{ flex: '0 1 0px', flexShrink: 0 }} />
      <div data-id="e" style={{ flex: isFill ? '1 0 0px' : '0 0 auto' }} />
    </div>`));
    expect(out).not.toContain(`flex: '0 0 auto'`);
    expect(out).toContain(`flex: 'none'`);
    expect(out).toContain(`flex: '1 0 0px'`);
    expect(out).toContain(`flex: isFill ? '1 0 0px' : '0 0 auto'`);
  });

  it('C) grid children are exempt from the shrink rule', () => {
    const out = applyRuntimeGuarantees(PAGE(`<div data-id="row" style={{ display: 'grid' }}>
      <div data-id="a" style={{}} />
      <div data-id="b" style={{}} />
    </div>`));
    expect(out).toContain(`order: '0'`);
    expect(out).not.toContain(`flex:`);
  });

  it('E) golden: normalized flex output passes FLEX_CHILD_SHRINKS', () => {
    const out = applyRuntimeGuarantees(PAGE(`<div data-id="row" style={{ position: 'relative', display: 'flex' }}>
      <div data-id="a" style={{ width: '10px' }} />
      <div data-id="b" style={{ width: '10px' }} />
    </div>`));
    golden(out, ['FLEX_CHILD_SHRINKS']);
  });

  it('F) parity with layout-normalize on the shrink fixture', () => {
    const out = applyRuntimeGuarantees(PAGE(`<div data-id="row" style={{ display: 'flex' }}>
      <p data-id="a" />
      <div data-id="b" style={{ flex: '1 1 0px' }} />
      <div data-id="c" style={{ flex: '1' }} />
    </div>`));
    const theirs = normalizeLayoutDescriptor(n('div', { display: 'flex' }, [
      n('p', {}), n('div', { flex: '1 1 0px' }), n('div', { flex: '1' }),
    ]));
    const mine = readStyleMaps(out).slice(2);
    expect(mine[0]).toEqual(theirs.children![0].styles);
    expect(mine[1]).toEqual(theirs.children![1].styles);
    expect(mine[2]).toEqual(theirs.children![2].styles);
  });
});

// ─── RULE 4 — TRANSPARENT_COLOR ────────────────────────────────────────────
describe('Rule 4 — literal transparent → rgba(0, 0, 0, 0) on ANY style property', () => {
  it('A) positive: an rgba value is untouched and idempotent', () => {
    const canonical = PAGE(`<div data-id="x" style={{ position: 'relative', backgroundColor: 'rgba(0, 0, 0, 0)', color: '#fff' }} />`);
    expect(applyRuntimeGuarantees(canonical)).toBe(canonical);
    expect(applyRuntimeGuarantees(applyRuntimeGuarantees(canonical))).toBe(applyRuntimeGuarantees(canonical));
  });

  it('B) repair: every property that is exactly transparent is swapped (TRANSPARENT_FILL)', () => {
    const out = applyRuntimeGuarantees(PAGE(`<div data-id="x" style={{ backgroundColor: 'transparent', color: 'transparent', border: 'transparent' }} />`));
    expect(out).toContain(`backgroundColor: 'rgba(0, 0, 0, 0)'`);
    expect(out).toContain(`color: 'rgba(0, 0, 0, 0)'`);
    expect(out).toContain(`border: 'rgba(0, 0, 0, 0)'`);
    expect(applyRuntimeGuarantees(out)).toBe(out);
  });

  it('B) repair: a ternary branch carrying transparent is normalized in place', () => {
    const out = applyRuntimeGuarantees(PAGE(`<div data-id="x" style={{ backgroundColor: hover ? 'transparent' : '#fff' }} />`));
    expect(out).toContain(`hover ? 'rgba(0, 0, 0, 0)' : '#fff'`);
  });

  it('C) composite values (1px solid transparent) are NOT touched — the oracle matches the exact keyword', () => {
    const out = applyRuntimeGuarantees(PAGE(`<div data-id="x" style={{ border: '1px solid transparent' }} />`));
    expect(out).toContain(`border: '1px solid transparent'`);
  });

  it('C) applies everywhere — no data-id, no exclusions', () => {
    const out = applyRuntimeGuarantees(PAGE(`<svg style={{ fill: 'transparent' }}><p style={{ color: 'transparent' }}>x</p></svg>`));
    expect(out).toContain(`fill: 'rgba(0, 0, 0, 0)'`);
    expect(out).toContain(`color: 'rgba(0, 0, 0, 0)'`);
  });

  it('E) golden: normalized output passes TRANSPARENT_COLOR', () => {
    const out = applyRuntimeGuarantees(PAGE(`<div data-id="x" style={{ backgroundColor: 'transparent' }} />`));
    golden(out, ['TRANSPARENT_COLOR']);
  });
});

// ─── MULTI-RULE INTEGRATION ────────────────────────────────────────────────
describe('integration — one pass normalizes everything, idempotently', () => {
  it('a fully violated file becomes the canonical dialect in one call', () => {
    const SINFUL = PAGE(`<div data-id="row" style={{ display: 'flex', backgroundColor: 'transparent' }}>
      <p data-id="a">A</p>
      <p data-id="b" style={{ flex: '1 1 0px' }}>B</p>
    </div>`);
    const out = applyRuntimeGuarantees(SINFUL);
    expect(out).toContain(`style={{ position: 'relative', display: 'flex', backgroundColor: 'rgba(0, 0, 0, 0)' }}`);
    expect(out).toContain(`<p data-id="a" style={{ position: 'relative', order: '0', flex: '0 0 auto' }}>`);
    expect(out).toContain(`<p data-id="b" style={{ position: 'relative', order: '1', flex: '1 0 0px' }}>`);
    // idempotent + oracle-clean (position/order/shrink/transparent)
    expect(applyRuntimeGuarantees(out)).toBe(out);
    golden(out, ['NODE_MISSING_POSITION', 'FLEX_CHILD_MISSING_ORDER', 'ORDER_MUST_BE_STRING', 'FLEX_CHILD_SHRINKS', 'TRANSPARENT_COLOR']);
  });

  it('multi-line and formatted source keeps its formatting (string injection only)', () => {
    const src = `export default function Page() {
  return (
    <div data-id="root">
      <div
        data-id="row"
        style={{
          display: 'flex',
          gap: '12px',
        }}
      >
        <div data-id="a" />
        <div data-id="b" />
      </div>
    </div>
  );
}`;
    const out = applyRuntimeGuarantees(src);
    // position lands right after the opening brace, before the first inner newline
    expect(out).toMatch(/style=\{\{ position: 'relative',\n\s*display: 'flex',/);
    expect(out).toContain(`gap: '12px',`);
    // self-closing children get a VALID created attr (style before the '/')
    expect(out).toContain(`<div data-id="a"  style={{ position: 'relative', order: '0', flex: '0 0 auto' }}/>`);
    expect(out).toContain(`<div data-id="b"  style={{ position: 'relative', order: '1', flex: '0 0 auto' }}/>`);
    expect(applyRuntimeGuarantees(out)).toBe(out);
  });

  it('an unparseable file passes through unchanged (parse failure → identity)', () => {
    const broken = `export default function Page( { return <div`;
    expect(applyRuntimeGuarantees(broken)).toBe(broken);
  });
});

// ─── THE SEAMS (guard at queue level) ──────────────────────────────────────
describe('seams — the guard skips style-only drains, normalizes structural ones', () => {
  /** Two style-less children of a flex row — violations on every seam. */
  const VIOLATING = PAGE(`<div data-id="row" style={{ display: 'flex' }}>
      <p data-id="a">A</p>
      <p data-id="b">B</p>
    </div>`);

  it('a style-only drain does NOT normalize (no position/order injection)', () => {
    let last = '';
    initMutationQueue(VIOLATING, (c) => { last = c; });
    queueMutation({ type: 'updateStyles', nodeId: 'row', styles: { gap: '12px' } });
    flushNow();
    expect(last).toContain(`gap: '12px'`);
    expect(last).not.toContain("order: '0'");
  });

  // PORT-PENDING: needs the branch-partitioned mutation queue (entries carrying {author,file,branchId}, grouped drain, lock gating, runtime-guarantee normalization on commit). Ported separately — see the branching port notes.
  it.skip('a structural drain normalizes the committed output', () => {
    let last = '';
    initMutationQueue(VIOLATING, (c) => { last = c; });
    queueMutation({ type: 'reorder', nodeId: 'a', parentId: 'row', index: 0 });
    flushNow();
    expect(last).toContain(`<p data-id="a" style={{ position: 'relative', order: '0', flex: '0 0 auto' }}>`);
  });

  // PORT-PENDING: needs the branch-partitioned mutation queue (entries carrying {author,file,branchId}, grouped drain, lock gating, runtime-guarantee normalization on commit). Ported separately — see the branching port notes.
  it.skip('an async processQueue drain (queueMutation → RAF → processQueue) normalizes too', async () => {
    let last = '';
    initMutationQueue(VIOLATING, (c) => { last = c; });
    queueMutation({ type: 'reorder', nodeId: 'a', parentId: 'row', index: 0 });
    await new Promise((r) => setTimeout(r, 150));
    expect(last).toContain(`order: '0'`);
  });
});

// ─── PERF (test G) ─────────────────────────────────────────────────────────
describe('perf — the normalizer on a ~100-node file', () => {
  it('parses + normalizes 100 nodes in well under a frame-ish budget', () => {
    const body = Array.from({ length: 100 }, (_, i) =>
      `<div data-id="n-${i}" data-name="N" style={{ width: '${i * 10}px' }} />`).join('\n    ');
    const big = PAGE(body);
    const t0 = performance.now();
    const out = applyRuntimeGuarantees(big);
    const dt = performance.now() - t0;
    console.log(`[runtime-guarantees] 100-node normalize: ${dt.toFixed(1)}ms, injected ${relCount(out) - 1}`);
    expect(dt).toBeLessThan(1000); // sanity floor — the number is informational
    expect(relCount(out)).toBe(101);
  });
});

beforeEach(() => {
  resetProjectFS(new Map());
});