// Locale inline-style residue lifecycle. clearLocaleStyleResidue runs BEFORE
// patchElement's style pass (which restores base values over cleared keys);
// applyLocaleOverrides runs AFTER it and stamps what it styled.
// Regression pair: "stuck on French in component masters" + "Done reverts to
// transparent-blue instead of base pink" (2026-07-22).
import { describe, it, expect } from 'vitest';
import { applyLocaleOverrides, clearLocaleStyleResidue } from './bindings';
import type { CanvasNode } from '@/code/parsing/parser';
import type { NodeOverride } from '@/shared/types';

const node = { id: 'n1', type: 'div', children: [], styles: { backgroundColor: '#ffb3ba' } } as unknown as CanvasNode;
const ov = (styles: Record<string, string>) => new Map<string, NodeOverride>([['n1', { styles }]]);

/** Simulate one patchElement visit: heal → base style pass → locale apply. */
function visit(el: HTMLElement, overrides: Map<string, NodeOverride> | undefined) {
  clearLocaleStyleResidue(el, overrides?.get('n1'), 'n1', '');
  // base style pass (patchElement re-applies node styles over cleared keys)
  el.style.backgroundColor = '#ffb3ba';
  applyLocaleOverrides(el, node, overrides, undefined, '');
}

describe('locale residue lifecycle', () => {
  it('FR visit applies the override inline and stamps the ledger', () => {
    const el = document.createElement('div');
    visit(el, ov({ backgroundColor: '#22bd21', opacity: '0.5' }));
    expect(el.style.backgroundColor).toBe('rgb(34, 189, 33)');
    expect(el.style.opacity).toBe('0.5');
    expect(el.getAttribute('data-locale-styled')).toBe('background-color,opacity');
  });

  it('back-to-default visit restores the BASE value (not transparent) and clears no-base props', () => {
    const el = document.createElement('div');
    visit(el, ov({ backgroundColor: '#22bd21', opacity: '0.5' }));
    visit(el, undefined);
    // base pink restored by the style pass — NOT wiped by the heal
    expect(el.style.backgroundColor).toBe('rgb(255, 179, 186)');
    // no-base prop fully removed
    expect(el.style.opacity).toBe('');
    expect(el.getAttribute('data-locale-styled')).toBeNull();
  });

  it('locale-to-locale switch keeps still-overridden keys and heals dropped ones', () => {
    const el = document.createElement('div');
    visit(el, ov({ backgroundColor: '#22bd21', opacity: '0.5' }));
    visit(el, ov({ backgroundColor: '#ff0000' }));
    expect(el.style.backgroundColor).toBe('rgb(255, 0, 0)');
    expect(el.style.opacity).toBe('');
    expect(el.getAttribute('data-locale-styled')).toBe('background-color');
  });
});
