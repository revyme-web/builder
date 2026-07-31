import { describe, test, expect } from 'vitest';
import { initMutationQueue, queueMutation, flushNow } from './mutation-queue';
import { setGlideInCode } from '../generation/glide-gen';

// Regression: a node dragged/added INTO a glide parent must inherit the glide so
// it slides with its siblings. Without re-applying glide, the newcomer lands as a
// plain child OUTSIDE the <LayoutGroup> and the effect skips it (the user's manual
// workaround was remove + re-add glide). The mutation queue now re-applies glide as
// a post-step on any move/addNode whose target parent has glide.

const GLIDE = { transition: { type: 'spring', duration: '0.5', bounce: '0.25', delay: '0' } };
const BASE = `<div data-id="root">\n  <div data-id="parent">\n    <div data-id="a"></div>\n  </div>\n</div>`;
const count = (code: string, re: RegExp) => (code.match(re) || []).length;

describe('glide inheritance on insert', () => {
  test('addNode into a glide parent wraps the newcomer as a glide-item', () => {
    const glided = setGlideInCode(BASE, 'parent', GLIDE);
    expect(count(glided, /data-glide-item/g)).toBe(1); // sanity: 'a' is wrapped

    let flushed = '';
    initMutationQueue(glided, (code) => { flushed = code; }, () => {}, () => {});
    queueMutation({ type: 'addNode', parentId: 'parent', node: { id: 'b', type: 'div', name: 'Frame', styles: {} }, index: 1 });
    flushNow();

    // 'b' now ALSO a glide-item (2 total) → it participates in the glide.
    expect(count(flushed, /data-glide-item/g)).toBe(2);
    expect(flushed).toContain('data-id="b"');
  });

  test('addNode into a NON-glide parent leaves it plain (no glide-item)', () => {
    let flushed = '';
    initMutationQueue(BASE, (code) => { flushed = code; }, () => {}, () => {});
    queueMutation({ type: 'addNode', parentId: 'parent', node: { id: 'b', type: 'div', name: 'Frame', styles: {} }, index: 1 });
    flushNow();
    expect(flushed).not.toContain('data-glide-item');
    expect(flushed).toContain('data-id="b"');
  });
});
