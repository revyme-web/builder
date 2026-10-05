import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseComponentControlsMeta } from '@/code/components/controls-parser';
import { compileCodeComponent } from '@/canvas/code-component-runtime';
import { checkFile } from '@/code/oracle/check-file';
import { EMBED_COMPONENT } from './index';

// The Insert > Utility > Interactive "Embed" template: drop a box, paste a
// URL or an embed snippet. Same contract as the other built-ins — metadata
// drives the Properties panel, the export wrapper makes instances
// responsive, and the gate's compile + smoke-render must hold or the canvas
// shows a blue placeholder.

describe('Embed template', () => {
  it('exposes @label, @comment and its controls', () => {
    const meta = parseComponentControlsMeta(EMBED_COMPONENT);
    expect(meta).not.toBeNull();
    expect(meta!.label).toBe('Embed');
    expect(meta!.comment).toBeTruthy();
    expect(Object.keys(meta!.controls)).toEqual([
      'url', 'embedCode', 'title',
      'allowFullscreen', 'allowScroll', 'background', 'borderRadius',
    ]);
  });

  it('exports default via withResponsiveProps', () => {
    expect(EMBED_COMPONENT).toMatch(/export default withResponsiveProps\(Embed\);/);
  });

  it('passes the oracle as a code component', () => {
    const v = checkFile(EMBED_COMPONENT, { kind: 'code-component', path: 'components/Embed.tsx' });
    expect(v).toEqual([]);
  });

  it('compiles and smoke-renders with no props (the gate check)', () => {
    const Comp = compileCodeComponent(EMBED_COMPONENT, 'Embed', { previewMode: false });
    expect(Comp).toBeTruthy();
    const html = renderToStaticMarkup(createElement(Comp as any));
    // Nothing configured yet → the "add a URL" placard, never a blank frame.
    expect(html).toContain('Properties panel');
    expect(html).not.toContain('<iframe');
  });

  it('renders a real iframe for a URL', () => {
    const Comp = compileCodeComponent(EMBED_COMPONENT, 'Embed', { previewMode: true });
    const html = renderToStaticMarkup(createElement(Comp as any, { url: 'https://example.com/widget' }));
    expect(html).toContain('<iframe');
    expect(html).toContain('src="https://example.com/widget"');
  });

  it('puts a pasted embed snippet in srcDoc, not the host page', () => {
    // React never executes a <script> it injects into the page, so an inline
    // snippet would silently render nothing — and running third-party script
    // on the host page is the wrong place for it besides.
    const Comp = compileCodeComponent(EMBED_COMPONENT, 'Embed', { previewMode: true });
    const html = renderToStaticMarkup(createElement(Comp as any, {
      embedCode: '<script src="https://widget.example/w.js"></script>',
    }));
    // HTML attribute names are case-insensitive, so the serializer keeping
    // React's `srcDoc` spelling is the same attribute to a browser.
    expect(html).toMatch(/srcdoc=/i);
    expect(html).toContain('widget.example');
    // The snippet must NOT be inlined into the host document.
    expect(html).not.toMatch(/<script/i);
  });

  it('honours the scroll and fullscreen toggles', () => {
    const Comp = compileCodeComponent(EMBED_COMPONENT, 'Embed', { previewMode: true });
    const on = renderToStaticMarkup(createElement(Comp as any, { url: 'https://a.test' }));
    expect(on).toMatch(/scrolling="auto"/);
    expect(on).toMatch(/allowfullscreen/i);

    const off = renderToStaticMarkup(createElement(Comp as any, {
      url: 'https://a.test', allowScroll: false, allowFullscreen: false,
    }));
    expect(off).toMatch(/scrolling="no"/);
    expect(off).not.toMatch(/allowfullscreen/i);
  });
});
