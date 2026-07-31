import { describe, test, expect } from 'vitest';
import {
  addComponentCursorInCode,
  updateComponentCursorInCode,
  removeComponentCursorInCode,
  ensureCursorPortalInLayout,
} from './cursor-gen';
import { parseComponentCursorCalls, getComponentCursorForNode } from '@/code/parsing/cursor-parser';

const MIN_PAGE = `'use client';

import React from 'react';

export default function Page() {
  return (
    <div data-id="root">
      <button data-id="cta">Click me</button>
    </div>
  );
}
`;

const SERVER_LAYOUT = `import type { Metadata } from 'next';
import LayoutClient from './LayoutClient';

export const metadata: Metadata = {
  title: 'Site',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <LayoutClient>{children}</LayoutClient>
      </body>
    </html>
  );
}
`;

describe('addComponentCursorInCode', () => {
  test('adds spread, runtime import, and component import', () => {
    const out = addComponentCursorInCode(MIN_PAGE, 'cta', {
      componentName: 'Pointer',
      componentImportPath: '@/components/Pointer',
      mode: 'follow',
      transition: { type: 'spring', stiffness: 300, damping: 30 },
    });

    expect(out).toContain(`import { withCursor } from '@revyme/runtime';`);
    expect(out).toContain(`import Pointer from '@/components/Pointer';`);
    expect(out).toMatch(/data-id="cta"\s+\{\.\.\.withCursor\(Pointer,/);
    expect(out).toContain(`mode: 'follow'`);
    expect(out).toContain(`type: 'spring'`);
    expect(out).toContain(`stiffness: 300`);
    expect(out).toContain(`damping: 30`);
  });

  test('does not duplicate runtime import when called twice on different nodes', () => {
    let code = addComponentCursorInCode(MIN_PAGE, 'cta', {
      componentName: 'Pointer',
      componentImportPath: '@/components/Pointer',
    });
    code = addComponentCursorInCode(code, 'root', {
      componentName: 'Pointer',
      componentImportPath: '@/components/Pointer',
    });

    const matches = code.match(/import \{ withCursor \} from '@revyme\/runtime';/g);
    expect(matches?.length).toBe(1);
    const componentMatches = code.match(/import Pointer from '@\/components\/Pointer';/g);
    expect(componentMatches?.length).toBe(1);
    expect(parseComponentCursorCalls(code).length).toBe(2);
  });

  test('add when one already exists on the node updates instead of duplicating', () => {
    let code = addComponentCursorInCode(MIN_PAGE, 'cta', {
      componentName: 'Pointer',
      componentImportPath: '@/components/Pointer',
      mode: 'follow',
    });
    code = addComponentCursorInCode(code, 'cta', {
      componentName: 'Pointer',
      componentImportPath: '@/components/Pointer',
      mode: 'replace',
    });

    expect(parseComponentCursorCalls(code).length).toBe(1);
    expect(getComponentCursorForNode(code, 'cta')?.mode).toBe('replace');
  });
});

describe('updateComponentCursorInCode', () => {
  test('changes the mode without breaking the call shape', () => {
    let code = addComponentCursorInCode(MIN_PAGE, 'cta', {
      componentName: 'Pointer',
      componentImportPath: '@/components/Pointer',
      mode: 'follow',
      transition: { type: 'spring', stiffness: 300 },
    });
    code = updateComponentCursorInCode(code, 'cta', { mode: 'replace' });

    const cursor = getComponentCursorForNode(code, 'cta');
    expect(cursor?.mode).toBe('replace');
    expect(cursor?.transition?.stiffness).toBe(300); // unchanged
  });

  test('switching component swaps the import', () => {
    let code = addComponentCursorInCode(MIN_PAGE, 'cta', {
      componentName: 'Pointer',
      componentImportPath: '@/components/Pointer',
    });
    code = updateComponentCursorInCode(code, 'cta', {
      componentName: 'Star',
      componentImportPath: '@/components/Star',
    });

    expect(code).toContain(`import Star from '@/components/Star';`);
    expect(code).not.toContain(`import Pointer from '@/components/Pointer';`);
    expect(getComponentCursorForNode(code, 'cta')?.componentName).toBe('Star');
  });
});

describe('removeComponentCursorInCode', () => {
  test('removes the spread', () => {
    let code = addComponentCursorInCode(MIN_PAGE, 'cta', {
      componentName: 'Pointer',
      componentImportPath: '@/components/Pointer',
    });
    code = removeComponentCursorInCode(code, 'cta');

    expect(code).not.toContain('withCursor');
    expect(code).not.toContain(`import Pointer from '@/components/Pointer';`);
    // Runtime import gone too since no calls remain.
    expect(code).not.toContain(`import { withCursor }`);
  });

  test('keeps imports while another cursor still uses them', () => {
    let code = addComponentCursorInCode(MIN_PAGE, 'cta', {
      componentName: 'Pointer',
      componentImportPath: '@/components/Pointer',
    });
    code = addComponentCursorInCode(code, 'root', {
      componentName: 'Pointer',
      componentImportPath: '@/components/Pointer',
    });
    code = removeComponentCursorInCode(code, 'cta');

    expect(code).toContain(`import Pointer from '@/components/Pointer';`);
    expect(code).toContain(`import { withCursor }`);
    expect(parseComponentCursorCalls(code).length).toBe(1);
  });

  test('is a no-op when no cursor exists for the node', () => {
    const out = removeComponentCursorInCode(MIN_PAGE, 'cta');
    expect(out).toBe(MIN_PAGE);
  });
});

describe('ensureCursorPortalInLayout', () => {
  test('adds import + mounts <CursorPortal /> inside <body>', () => {
    const out = ensureCursorPortalInLayout(SERVER_LAYOUT);

    expect(out).toContain(`import { CursorPortal } from '@revyme/runtime';`);
    expect(out).toMatch(/<CursorPortal \/>\s*\n\s*<\/body>/);
  });

  test('is idempotent — calling twice does not duplicate', () => {
    let out = ensureCursorPortalInLayout(SERVER_LAYOUT);
    out = ensureCursorPortalInLayout(out);

    const importMatches = out.match(/import \{ CursorPortal \}/g);
    const mountMatches = out.match(/<CursorPortal \/>/g);
    expect(importMatches?.length).toBe(1);
    expect(mountMatches?.length).toBe(1);
  });
});

// ─── Per-instance behaviour overrides (`<prop>Opts`) ─────────────────────────
// The master forwards `...cursorOpts` LAST in its withCursor opts so an
// instance's `cursorOpts={{…}}` overrides the shared defaults. Live find
// 2026-07-06: instance behaviour edits wrote the MASTER call, so "Brand" on
// row 1 was silently replaced by "Motion" set on row 2.
import { ensureCursorOptsForwardInCode, serializeInstanceCursorOpts, parseInstanceCursorOpts, cursorOptsPropName } from './cursor-gen';

describe('ensureCursorOptsForwardInCode', () => {
  const MASTER = `function Card({ style, initialVariant = 'default', cursor = () => null, ...rest }: any) {
  return <div data-id="root" {...withCursor(cursor, { variant: 'variant-2', mode: 'replace', transition: { type: 'spring', stiffness: 300, damping: 30 } })} {...rest} />;
}`;

  test('adds the opts param before ...rest and spreads it LAST into the call', () => {
    const out = ensureCursorOptsForwardInCode(MASTER, 'cursor');
    expect(out).toContain('cursorOpts = {}, ...rest');
    expect(out).toMatch(/withCursor\(cursor, \{ variant: 'variant-2', mode: 'replace', transition: \{ [^}]*\}, \.\.\.cursorOpts \}\)/);
  });

  test('is idempotent', () => {
    const once = ensureCursorOptsForwardInCode(MASTER, 'cursor');
    const twice = ensureCursorOptsForwardInCode(once, 'cursor');
    expect(twice).toBe(once);
  });

  test('handles an EMPTY opts object', () => {
    const empty = MASTER.replace(/\{ variant:[^)]*\}\)/, '{})');
    const out = ensureCursorOptsForwardInCode(empty, 'cursor');
    expect(out).toContain('withCursor(cursor, { ...cursorOpts })');
  });

  test('no-ops (returns input) when the call or ...rest is missing', () => {
    expect(ensureCursorOptsForwardInCode('function X() { return null; }', 'cursor'))
      .toBe('function X() { return null; }');
  });
});

describe('serialize/parse instance cursor opts', () => {
  test('round-trips behaviour opts as JSON', () => {
    const json = serializeInstanceCursorOpts({ variant: 'brand', mode: 'replace', transition: { type: 'spring', stiffness: 300, damping: 30 } });
    const back = parseInstanceCursorOpts(json);
    expect(back).toEqual({ variant: 'brand', mode: 'replace', transition: { type: 'spring', stiffness: 300, damping: 30 } });
  });

  test('omits empty/zero-ish fields and survives invalid input', () => {
    expect(JSON.parse(serializeInstanceCursorOpts({ variant: '', offsetX: 0, width: '0' }))).toEqual({});
    expect(parseInstanceCursorOpts(undefined)).toBeNull();
    expect(parseInstanceCursorOpts('not json')).toBeNull();
  });

  test('cursorOptsPropName pairs by suffix', () => {
    expect(cursorOptsPropName('cursor')).toBe('cursorOpts');
    expect(cursorOptsPropName('myCursor')).toBe('myCursorOpts');
  });
});
