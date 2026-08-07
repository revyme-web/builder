import { describe, it, expect } from 'vitest';
import { healDanglingModuleJsxInCode } from './generator-crud';
import { parseJSX } from '@/code/parsing/ast-utils';

// A data-id'd element dangling as a bare module statement (outside Page and
// canvasNodes) — the 2026-08-07 corruption: a duplicate <p> after the
// canvasNodes fragment poisoned the node map (same data-id twice).
const PAGE = `import React from 'react';
export default function Page() {
  return <div data-id="root">
    <div data-id="card-1">
      <p data-id="p-msiy3nzq-1" data-name="Text" style={{ order: '0' }}>
        <span>At RemodelWest we build.</span>
      </p>
    </div>
  </div>;
}
const canvasNodes = <>

</>;

<p data-id="p-msiy3nzq-1" data-name="Text" style={{ order: '0' }}>
  <span>At RemodelWest we build.</span>
</p>;`;

describe('healDanglingModuleJsxInCode', () => {
  it('drops a dangling DUPLICATE (id lives in the real tree)', () => {
    const out = healDanglingModuleJsxInCode(PAGE);
    expect(out.match(/data-id="p-msiy3nzq-1"/g)?.length).toBe(1); // in-card copy only
    expect(parseJSX(out)).not.toBeNull();
  });

  it('folds a UNIQUE dangling node into canvasNodes instead of dropping it', () => {
    const unique = PAGE.replace(/p-msiy3nzq-1" data-name="Text" style=\{\{ order: '0' \}\}>\n  <span>/, 'p-orphan-9" data-name="Text" style={{ order: \'0\' }}>\n  <span>');
    const out = healDanglingModuleJsxInCode(unique);
    expect(out).toContain('data-id="p-orphan-9"');
    expect(out).toContain('data-canvas-node="true"');
    const declIdx = out.indexOf('const canvasNodes');
    expect(out.indexOf('data-id="p-orphan-9"')).toBeGreaterThan(declIdx); // inside the fragment
    expect(parseJSX(out)).not.toBeNull();
  });

  it('no-ops on a clean file', () => {
    const clean = `export default function Page() {\n  return <div data-id="root"></div>;\n}`;
    expect(healDanglingModuleJsxInCode(clean)).toBe(clean);
  });
});
