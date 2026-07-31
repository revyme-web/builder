import { describe, it, expect } from 'vitest';
import { moveNodeIntoParentFast, extractPlainElementSpan, directChildStarts } from './move-fast';
import { moveNodeInCode } from './generator-crud';
import { parseJSXToNodes } from '../parsing/parser';

// Parse the moved code and return parentId of `nodeId`.
function parentOf(code: string, nodeId: string): string | null | undefined {
  const nodes = parseJSXToNodes(code);
  return nodes.get(nodeId)?.parentId;
}
function childIdsOf(code: string, parentId: string): string[] {
  const nodes = parseJSXToNodes(code);
  return nodes.get(parentId)?.children ?? [];
}

const PAGE = (body: string) => `'use client';
export default function Page() {
  return (
${body}
  );
}`;

describe('moveNodeIntoParentFast — happy path', () => {
  it('reparents a plain div into another plain div (append)', () => {
    const code = PAGE(`    <div data-id="root" data-name="Page">
      <div data-id="a" data-name="A"></div>
      <div data-id="b" data-name="B"></div>
    </div>`);
    const out = moveNodeIntoParentFast(code, 'a', 'b', null);
    expect(out).not.toBeNull();
    expect(parentOf(out!, 'a')).toBe('b');
    expect(childIdsOf(out!, 'root')).toEqual(['b']);
    expect(childIdsOf(out!, 'b')).toEqual(['a']);
  });

  it('preserves the moved node\'s nested children', () => {
    const code = PAGE(`    <div data-id="root" data-name="Page">
      <div data-id="a" data-name="A"><span data-id="a-kid" data-name="Kid">hi</span></div>
      <div data-id="b" data-name="B"></div>
    </div>`);
    const out = moveNodeIntoParentFast(code, 'a', 'b', null)!;
    expect(parentOf(out, 'a')).toBe('b');
    expect(parentOf(out, 'a-kid')).toBe('a');
  });

  it('strips data-canvas-node="true" from the moved node', () => {
    const code = PAGE(`    <div data-id="root" data-name="Page">
      <div data-id="frame" data-name="Frame"></div>
    </div>`) + `\nconst canvasNodes = (<>\n  <div data-id="chip" data-canvas-node="true" style={{ position: 'absolute' }}></div>\n</>);`;
    // move chip into frame (still string-splice; chip is a plain child of the fragment)
    const out = moveNodeIntoParentFast(code, 'chip', 'frame', null);
    expect(out).not.toBeNull();
    expect(out).not.toContain('data-canvas-node="true"');
    expect(parentOf(out!, 'chip')).toBe('frame');
  });

  it('inserts at a specific index among children', () => {
    const code = PAGE(`    <div data-id="root" data-name="Page">
      <div data-id="a" data-name="A"></div>
      <div data-id="p" data-name="P">
        <div data-id="x" data-name="X"></div>
        <div data-id="y" data-name="Y"></div>
      </div>
    </div>`);
    const out = moveNodeIntoParentFast(code, 'a', 'p', 1)!;
    expect(childIdsOf(out, 'p')).toEqual(['x', 'a', 'y']);
  });

  it('self-closing moved element works', () => {
    const code = PAGE(`    <div data-id="root" data-name="Page">
      <img data-id="a" data-name="A" src="x" />
      <div data-id="b" data-name="B"></div>
    </div>`);
    const out = moveNodeIntoParentFast(code, 'a', 'b', null)!;
    expect(parentOf(out, 'a')).toBe('b');
  });
});

describe('moveNodeIntoParentFast — bails to AST (returns null)', () => {
  const wrap = (body: string) => PAGE(`    <div data-id="root" data-name="Page">${body}</div>`);

  it('null / wrapped conditional node', () => {
    const code = wrap(`{open && <div data-id="a" data-name="A"></div>}<div data-id="b" data-name="B"></div>`);
    expect(moveNodeIntoParentFast(code, 'a', 'b', null)).toBeNull();
  });

  it('duplicate data-id', () => {
    const code = wrap(`<div data-id="a"></div><div data-id="a"></div><div data-id="b"></div>`);
    expect(moveNodeIntoParentFast(code, 'a', 'b', null)).toBeNull();
  });

  it('self-closing target parent', () => {
    const code = wrap(`<div data-id="a"></div><img data-id="b" src="x" />`);
    expect(moveNodeIntoParentFast(code, 'a', 'b', null)).toBeNull();
  });

  it('target parent holds a .map()', () => {
    const code = wrap(`<div data-id="a"></div><div data-id="b">{items.map((i) => <span data-id="t" key={i}/>)}</div>`);
    expect(moveNodeIntoParentFast(code, 'a', 'b', null)).toBeNull();
  });

  it('move into self', () => {
    const code = wrap(`<div data-id="a"></div>`);
    expect(moveNodeIntoParentFast(code, 'a', 'a', null)).toBeNull();
  });

  it('parent inside the moved subtree (would delete parent)', () => {
    const code = wrap(`<div data-id="a"><div data-id="b"></div></div><div data-id="c"></div>`);
    // move a into b — b is a's child; after cutting a, b is gone → bail
    expect(moveNodeIntoParentFast(code, 'a', 'b', null)).toBeNull();
  });
});

describe('moveNodeIntoParentFast — matches AST path output semantics', () => {
  it('produces the same node tree as moveNodeInCode (append)', () => {
    const code = PAGE(`    <div data-id="root" data-name="Page">
      <div data-id="a" data-name="A"><span data-id="ak">t</span></div>
      <div data-id="b" data-name="B"><span data-id="bk">u</span></div>
    </div>`);
    const fast = moveNodeIntoParentFast(code, 'a', 'b', null)!;
    const ast = moveNodeInCode(code, 'a', 'b');
    // Same parent + same child set (order-independent structural equality).
    expect(parentOf(fast, 'a')).toBe(parentOf(ast, 'a'));
    expect(new Set(childIdsOf(fast, 'b'))).toEqual(new Set(childIdsOf(ast, 'b')));
    expect(new Set(childIdsOf(fast, 'root'))).toEqual(new Set(childIdsOf(ast, 'root')));
  });
});

describe('directChildStarts', () => {
  it('counts element + expression children, skips text', () => {
    const region = `<a></a> some text {expr} <b/>`;
    const starts = directChildStarts(region, 0, region.length);
    expect(starts).not.toBeNull();
    expect(starts!.length).toBe(3); // <a>, {expr}, <b/>
  });
});
