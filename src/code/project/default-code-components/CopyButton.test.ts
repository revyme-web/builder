import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseComponentControlsMeta } from '@/code/components/controls-parser';
import { compileCodeComponent } from '@/canvas/code-component-runtime';
import { checkFile } from '@/code/oracle/check-file';
import { COPY_BUTTON_COMPONENT } from './index';

// The Insert > Utility > Interactive "Copy Button" template. Same contract as
// the other built-ins: metadata drives the Properties panel, the export
// wrapper makes instances responsive, and the gate's compile + smoke-render
// must hold or the canvas shows a blue placeholder.

describe('CopyButton template', () => {
  it('exposes @label, @comment and the value/label controls', () => {
    const meta = parseComponentControlsMeta(COPY_BUTTON_COMPONENT);
    expect(meta).not.toBeNull();
    expect(meta!.label).toBe('Copy Button');
    expect(meta!.comment).toBeTruthy();
    expect(Object.keys(meta!.controls)).toEqual(['value', 'label', 'copiedLabel']);
  });

  it('exports default via withResponsiveProps', () => {
    expect(COPY_BUTTON_COMPONENT).toMatch(/export default withResponsiveProps\(CopyButton\);/);
  });

  it('passes the oracle as a code component', () => {
    const v = checkFile(COPY_BUTTON_COMPONENT, { kind: 'code-component', path: 'components/CopyButton.tsx' });
    expect(v).toEqual([]);
  });

  it('compiles and smoke-renders with no props (the gate check)', async () => {
    const Comp = compileCodeComponent(COPY_BUTTON_COMPONENT, 'CopyButton', { previewMode: false });
    expect(Comp).toBeTruthy();
    const html = renderToStaticMarkup(createElement(Comp as any));
    expect(html).toContain('Copy');
    expect(html).toContain('type="button"');
  });
});
