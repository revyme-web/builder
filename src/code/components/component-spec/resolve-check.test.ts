import { describe, it, expect } from 'vitest';
import { resolveCheck } from './resolve-check';
import { compileBundle } from './compile';
import type { ComponentBundle } from './types';

function menuBundle(): ComponentBundle {
  return {
    entry: 'Menu',
    components: [
      {
        name: 'Menu', displayName: 'Menu', isNew: false, rootId: 'root',
        variants: [
          { name: 'default', label: 'Default', kind: 'interactive' },
          { name: 'open', label: 'Open', kind: 'interactive' },
        ],
        elements: [
          { kind: 'element', id: 'root', tag: 'div', visibleIn: ['default', 'open'],
            base: { paint: { backgroundColor: '#fff' }, layout: { flexDirection: 'row' } },
            variantStyles: [{ variant: 'open', paint: { backgroundColor: '#eee' }, layout: { flexDirection: 'column' } }],
            children: ['panel'] },
          { kind: 'element', id: 'panel', tag: 'div', visibleIn: ['open'], base: { paint: {} } },
        ],
        connections: [{ from: 'default', to: 'open', trigger: 'click', sourceElement: 'root' }],
      },
    ],
  };
}

describe('resolveCheck', () => {
  it('passes the compiler output (parses + resolves every variant)', () => {
    const files = compileBundle(menuBundle());
    const violations = resolveCheck(files);
    expect(violations).toEqual([]);
  });

  it('fails unparseable code', () => {
    const violations = resolveCheck([{ filePath: 'components/X.tsx', code: 'this is not <<< valid tsx {{{' }]);
    expect(violations.map((x) => x.code)).toContain('RESOLVE_FAILED');
  });

  it('flags a missing withResponsiveProps export', () => {
    const violations = resolveCheck([{ filePath: 'components/X.tsx', code: 'export default function X(){ return null; }' }]);
    expect(violations.map((x) => x.code)).toContain('BAD_EXPORT');
  });
});
