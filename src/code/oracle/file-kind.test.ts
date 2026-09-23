import { describe, expect, it } from 'vitest';
import { oracleFileKind, isBuilderMaterializedFile } from './file-kind';

describe('oracleFileKind', () => {
  it('judges pages, templates and components by path', () => {
    expect(oracleFileKind('app/page.client.tsx', '')).toBe('page');
    expect(oracleFileKind('app/(site)/about/page.client.tsx', '')).toBe('page');
    expect(oracleFileKind('app/(site)/LayoutClient.tsx', '')).toBe('template');
    expect(oracleFileKind('components/Card.tsx', "'use client';")).toBe('component');
    expect(oracleFileKind('components/Galaxy.tsx', '/** @controls { "a": {} } */')).toBe('code-component');
  });

  it('skips the builder plumbing a project scan would otherwise misjudge as pages', () => {
    for (const p of ['app/page.tsx', 'app/layout.tsx', 'app/(site)/layout.tsx', 'app/providers.tsx', 'app/smooth-scroll-controller.tsx', 'app/(site)/page-transitions.tsx', 'app/(site)/page-effects-runtime.tsx', 'app/globals.css', 'messages/fr.json']) {
      expect(oracleFileKind(p, ''), p).toBeNull();
    }
  });

  it('recognises materialized files by their stamp', () => {
    expect(isBuilderMaterializedFile('/** @revyme-providers v3 */')).toBe(true);
    expect(isBuilderMaterializedFile("'use client';\n/** @name \"Form Submit\" */")).toBe(true);
    expect(isBuilderMaterializedFile("'use client';\n/** @name \"Card\" */")).toBe(false);
  });
});

describe('the builder\'s own template scaffold passes the oracle', () => {
  it('createRouteGroup\'s LayoutClient (minHeight 100vh on the shell root) has zero violations', async () => {
    const { checkFile } = await import('./check-file');
    const { createRouteGroup } = await import('@/code/project/active-file-store');
    const fs = await import('@/code/project/project-fs');
    fs.resetProjectFS(new Map());
    createRouteGroup('site', true);
    // `projectFS` is reassigned by the reset — read it through the module.
    const code = fs.projectFS.readFile('app/(site)/LayoutClient.tsx') ?? '';
    expect(code).toContain("minHeight: '100vh'");
    expect(checkFile(code, { kind: 'template', path: 'app/(site)/LayoutClient.tsx' })).toEqual([]);
  });
});

describe('CODE_COMPONENT_CONTROLS_INVALID', () => {
  const component = (controls: string) => `'use client';

/** @label "Dot" */
/** @defaultWidth 100 */
/** @defaultHeight 100 */
/** @controls ${controls} */

import { withResponsiveProps } from '@revyme/runtime';

function Dot({ color = '#000', ...props }: { color?: string; [key: string]: any }) {
  return <div {...props} style={{ position: 'relative', backgroundColor: color, ...props.style }} />;
}

export default withResponsiveProps(Dot);
`;

  it('flags a block that is not JSON (trailing comma) — the panel would show zero controls', async () => {
    const { checkFile } = await import('./check-file');
    const vs = checkFile(component('{ "color": { "type": "color", "label": "Color", "default": "#000", } }'), { kind: 'code-component', path: 'components/Dot.tsx' });
    expect(vs.map((v) => v.code)).toContain('CODE_COMPONENT_CONTROLS_INVALID');
  });

  it('flags a control without a type or with an unknown type', async () => {
    const { checkFile } = await import('./check-file');
    const noType = checkFile(component('{ "color": { "label": "Color", "default": "#000" } }'), { kind: 'code-component', path: 'components/Dot.tsx' });
    expect(noType.find((v) => v.code === 'CODE_COMPONENT_CONTROLS_INVALID')?.message).toMatch(/color: no "type"/);
    const unknown = checkFile(component('{ "color": { "type": "colour", "label": "Color", "default": "#000" } }'), { kind: 'code-component', path: 'components/Dot.tsx' });
    expect(unknown.find((v) => v.code === 'CODE_COMPONENT_CONTROLS_INVALID')?.message).toMatch(/unknown type "colour"/);
  });

  it('stays silent on a well-formed block', async () => {
    const { checkFile } = await import('./check-file');
    const vs = checkFile(component('{ "color": { "type": "color", "label": "Color", "default": "#000" } }'), { kind: 'code-component', path: 'components/Dot.tsx' });
    expect(vs.map((v) => v.code)).not.toContain('CODE_COMPONENT_CONTROLS_INVALID');
  });
});

describe('RAW_STYLE_TAG — the editor\'s own empty block', () => {
  it('an emptied <style> block (last breakpoint removed) passes', async () => {
    const { checkFile } = await import('./check-file');
    const { FIXTURE_FILES, HOME } = await import('@/ai/agent/capability/fixture');
    // The fixture has no style block; give the root an emptied one.
    const code = FIXTURE_FILES[HOME].replace('<div data-id="hero"', '<style>{`\n  `}</style>\n      <div data-id="hero"');
    expect(code).toContain('<style>{`\n  `}</style>');
    expect(checkFile(code, { kind: 'page', path: HOME }).map((v) => v.code)).not.toContain('RAW_STYLE_TAG');
  });
});

describe('the builder\'s FIT text wrapper passes the oracle', () => {
  it('wrapInFitSVGInCode output has no RESOLVE_UNIDENTIFIED_ELEMENT for its foreignObject', async () => {
    const { checkFile } = await import('./check-file');
    const { wrapInFitSVGInCode } = await import('@/code/generation/fit-text-gen');
    const { FIXTURE_FILES, HOME } = await import('@/ai/agent/capability/fixture');
    const out = wrapInFitSVGInCode(FIXTURE_FILES[HOME], 'hero-title', { width: 900, height: 80, fontSize: 64, marginTop: 2 }, { width: '100%' });
    expect(out).toContain('<foreignObject');
    expect(checkFile(out, { kind: 'page', path: HOME }).map((v) => v.code)).toEqual([]);
  });
});
