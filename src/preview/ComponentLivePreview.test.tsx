// ComponentLivePreview.test.tsx — the preview host must keep a tall component
// reachable.
//
// The wrapper used `align-items/justify-content: center` on its scroll
// container: flex centering distributes overflow to BOTH sides, and anything
// above the scroll origin cannot be scrolled to — a component variant taller
// than the window had its top cut off (tall single-column pricing variant,
// 2026-08-11). Centering now comes from `margin: auto !important` on the
// scoped child, which is identical for small components but collapses to 0
// under overflow so the whole component scrolls. jsdom has no layout engine,
// so these tests pin the CSS contract itself.

import { describe, it, expect, beforeEach } from 'vitest';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import ComponentLivePreview from './ComponentLivePreview';
import { projectFS } from '@/code/project/project-fs';
import { clearCodeComponentCache } from '@/canvas/code-component-runtime';

const MASTER = `
'use client';
import React from 'react';
import { withResponsiveProps } from '@revyme/runtime';

function Tall({ style, ...rest }) {
  return <div data-id="tall-root" {...rest} style={{ position: 'absolute', left: '1135px', top: '161px', height: '4000px', ...style }}>tall</div>;
}
export default withResponsiveProps(Tall);
`;

beforeEach(() => {
  clearCodeComponentCache();
  projectFS.writeFile('components/Tall.tsx', MASTER);
});

describe('ComponentLivePreview — overflow reachability', () => {
  it('renders the compiled component (assertions below run on the real branch)', () => {
    const html = renderToStaticMarkup(createElement(ComponentLivePreview, { componentFilePath: 'components/Tall.tsx' }));
    expect(html).toContain('data-id="tall-root"');
  });

  it('does NOT center via the flex container (that clips overflow above the scroll origin)', () => {
    const html = renderToStaticMarkup(createElement(ComponentLivePreview, { componentFilePath: 'components/Tall.tsx' }));
    const wrapperStyle = /<div id="preview-components-Tall-tsx" style="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(wrapperStyle).toContain('overflow:auto');
    expect(wrapperStyle).not.toContain('align-items:center');
    expect(wrapperStyle).not.toContain('justify-content:center');
  });

  it('centers the scoped child with auto margins and forbids flex shrink', () => {
    const html = renderToStaticMarkup(createElement(ComponentLivePreview, { componentFilePath: 'components/Tall.tsx' }));
    const scopeCss = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
    expect(scopeCss).toContain('margin: auto !important');
    expect(scopeCss).toContain('flex-shrink: 0');
    // The canvas-coord neutralize rule stays.
    expect(scopeCss).toContain('position: relative !important');
  });

  it('the neutralize rule also targets the tagged root (wrapper-DOM robustness)', () => {
    // A `>` child selector alone dies as soon as ANY element (a providers
    // div, the runtime ref socket) sits between the container and the master
    // root — the preview-sandbox bug. The rule must also match by tag.
    const html = renderToStaticMarkup(createElement(ComponentLivePreview, { componentFilePath: 'components/Tall.tsx' }));
    const scopeCss = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
    expect(scopeCss).toContain('[data-id][data-preview-master-root]');
  });

  it('tags the master root with data-preview-master-root after mount', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(createElement(ComponentLivePreview, { componentFilePath: 'components/Tall.tsx' }));
    });
    const master = host.querySelector('[data-id="tall-root"]');
    expect(master).not.toBeNull();
    expect(master!.hasAttribute('data-preview-master-root')).toBe(true);
    await act(async () => { root.unmount(); });
    host.remove();
  });
});
