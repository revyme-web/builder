// sandbox-dom-utils.test.ts — locks the shared node-id lookup contract (9.4e).
//
// The one sanctioned behavior decision of the consolidation: the selector is
// cssEscape'd uniformly (promoted from text-edit-host's local copy). Node ids
// are generated safe, so for real ids the escaped selector matches exactly
// what the previous raw interpolation matched.

import { describe, it, expect } from 'vitest';
import { cssEscape, nodeIdSelector, findElByNodeId, findAllByNodeId } from './sandbox-dom-utils';

function makeRoot(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

describe('cssEscape', () => {
  it('escapes selector-significant characters', () => {
    expect(cssEscape('a.b')).toBe('a\\.b');
    expect(cssEscape('a:b')).toBe('a\\:b');
    expect(cssEscape('a"b')).toBe('a\\"b');
  });

  it('leaves generated-safe ids untouched', () => {
    expect(cssEscape('tablet-frameMr2ed4ynB')).toBe('tablet-frameMr2ed4ynB');
    expect(cssEscape('tpl__3')).toBe('tpl__3');
  });
});

describe('nodeIdSelector', () => {
  it('builds the exact-match attribute selector from prefix + id', () => {
    expect(nodeIdSelector('tablet-', 'frame1')).toBe('[data-node-id="tablet-frame1"]');
    expect(nodeIdSelector('', 'frame1')).toBe('[data-node-id="frame1"]');
  });
});

describe('findElByNodeId', () => {
  it('finds the element rendering the node under the given prefix', () => {
    const root = makeRoot('<div data-node-id="frame1"></div><div data-node-id="tablet-frame1" id="hit"></div>');
    expect(findElByNodeId(root, 'tablet-', 'frame1')?.id).toBe('hit');
    expect(findElByNodeId(root, '', 'frame1')?.id).toBe('');
  });

  it('returns null when absent', () => {
    const root = makeRoot('<div data-node-id="other"></div>');
    expect(findElByNodeId(root, '', 'frame1')).toBeNull();
  });

  it('matches expanded instance ids containing a colon (escaped)', () => {
    const root = makeRoot('<div data-node-id="inst1:child2" id="hit"></div>');
    expect(findElByNodeId(root, '', 'inst1:child2')?.id).toBe('hit');
  });
});

describe('findAllByNodeId', () => {
  it('returns every painting of the id in DOM order', () => {
    const root = makeRoot(
      '<div data-node-id="tpl" id="a"></div><div data-node-id="tpl" id="b"></div><div data-node-id="tablet-tpl"></div>',
    );
    const els = findAllByNodeId(root, '', 'tpl');
    expect(els.map(e => e.id)).toEqual(['a', 'b']);
  });

  it('returns an empty array when absent', () => {
    expect(findAllByNodeId(makeRoot(''), '', 'x')).toEqual([]);
  });
});
