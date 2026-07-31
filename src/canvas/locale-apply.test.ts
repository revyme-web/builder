// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { applyLocaleOverrides } from './renderer/bindings';

describe('applyLocaleOverrides — build + patch share one locale application', () => {
  const node: any = { id: 'n1' };
  const mk = () => document.createElement('div');

  it('applies text, props and styles for the matching node', () => {
    const el = mk();
    const overrides = new Map<string, any>([['n1', { text: 'Bonjour', props: { 'aria-label': 'fr' }, styles: { color: 'rgb(1, 2, 3)' } }]]);
    applyLocaleOverrides(el, node, overrides, undefined, '');
    expect(el.textContent).toBe('Bonjour');
    expect(el.getAttribute('aria-label')).toBe('fr');
    expect(el.style.color).toBe('rgb(1, 2, 3)');
  });

  it('no override for the node → element untouched', () => {
    const el = mk(); el.textContent = 'orig';
    applyLocaleOverrides(el, node, new Map([['other', { text: 'x' }]]), undefined, 'build-');
    expect(el.textContent).toBe('orig');
  });

  it('falls back to override.text when no viewport bucket applies (the build path default)', () => {
    const el = mk();
    // _allViewportWidthsAsc is empty in this isolated import → bucketing skipped → primary text.
    const overrides = new Map<string, any>([['n1', { text: 'Primary', textOverrides: { '768': 'Tablet' } }]]);
    applyLocaleOverrides(el, node, overrides, 768, 'build-');
    expect(el.textContent).toBe('Primary');
  });
});
