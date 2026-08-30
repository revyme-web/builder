import { describe, test, expect } from 'vitest';
import {
  setTextOverrideInCode,
  removeTextOverrideInCode,
  getTextOverrideWidths,
  HOOK_NAME,
} from './text-override-gen';

const PRIMARY = 1440;
const TABLET = 768;
const MOBILE = 375;
const ALL_VPS = [MOBILE, TABLET, PRIMARY];

const PLAIN = `'use client';
import React from 'react';
export default function Page() {
  return <p data-id="t1">Hello</p>;
}`;

describe('setTextOverrideInCode', () => {
  test('plain element + first non-primary override → wraps in useResponsiveText', () => {
    const out = setTextOverrideInCode(PLAIN, 't1', TABLET, PRIMARY, 'Hi tablet', ALL_VPS);
    expect(out).toMatch(new RegExp(`${HOOK_NAME}\\(['"]Hello['"]`));
    expect(out).toMatch(/768:\s*['"]Hi tablet['"]/);
    // Hook definition was injected.
    expect(out).toContain(`function ${HOOK_NAME}(primary, overrides`);
    // useState + useEffect added to react import (named imports may follow
    // the default `React` specifier, so match against the whole import line).
    expect(out).toMatch(/import\s+[^;]*useState[^;]*from\s+['"]react['"]/);
    expect(out).toMatch(/import\s+[^;]*useLayoutEffect[^;]*from\s+['"]react['"]/);
    expect(out).toMatch(/import\s+[^;]*useRef[^;]*from\s+['"]react['"]/);
  });

  test('plain element + primary edit → updates JSXText only (no wrap)', () => {
    const out = setTextOverrideInCode(PLAIN, 't1', PRIMARY, PRIMARY, 'Updated primary');
    expect(out).toContain('Updated primary');
    expect(out).not.toContain(HOOK_NAME);
    expect(out).not.toContain('useState');
  });

  test('wrapped element + add second viewport override', () => {
    let code = setTextOverrideInCode(PLAIN, 't1', TABLET, PRIMARY, 'Hi tablet', ALL_VPS);
    code = setTextOverrideInCode(code, 't1', MOBILE, PRIMARY, 'Hi mobile');
    expect(code).toMatch(/768:\s*['"]Hi tablet['"]/);
    expect(code).toMatch(/375:\s*['"]Hi mobile['"]/);
    // Hook function still injected once (not duplicated)
    expect(code.match(new RegExp(`function ${HOOK_NAME}`, 'g'))?.length).toBe(1);
  });

  test('wrapped element + update existing viewport override (no duplicate key)', () => {
    let code = setTextOverrideInCode(PLAIN, 't1', TABLET, PRIMARY, 'old');
    code = setTextOverrideInCode(code, 't1', TABLET, PRIMARY, 'new');
    // Only one tablet entry, with the updated text
    const matches = code.match(/768:\s*['"][^'"]*['"]/g) ?? [];
    expect(matches).toHaveLength(1);
    expect(code).toMatch(/768:\s*['"]new['"]/);
    expect(code).not.toMatch(/['"]old['"]/);
  });

  test('wrapped element + primary edit updates first arg only', () => {
    let code = setTextOverrideInCode(PLAIN, 't1', TABLET, PRIMARY, 'Hi tablet', ALL_VPS);
    code = setTextOverrideInCode(code, 't1', PRIMARY, PRIMARY, 'New primary');
    expect(code).toMatch(new RegExp(`${HOOK_NAME}\\(['"]New primary['"]`));
    expect(code).toMatch(/768:\s*['"]Hi tablet['"]/);
  });

  test('removing the only override unwraps back to plain text + drops hook fn', () => {
    let code = setTextOverrideInCode(PLAIN, 't1', TABLET, PRIMARY, 'Hi tablet', ALL_VPS);
    expect(code).toContain(HOOK_NAME);
    code = setTextOverrideInCode(code, 't1', TABLET, PRIMARY, '');
    expect(code).not.toContain(HOOK_NAME);
    expect(code).not.toContain('function useResponsiveText');
    // Original primary text restored
    expect(code).toContain('Hello');
  });

  test('removing one of two overrides keeps wrap + remaining viewport', () => {
    let code = setTextOverrideInCode(PLAIN, 't1', TABLET, PRIMARY, 'Hi tablet', ALL_VPS);
    code = setTextOverrideInCode(code, 't1', MOBILE, PRIMARY, 'Hi mobile');
    code = setTextOverrideInCode(code, 't1', TABLET, PRIMARY, '');
    expect(code).toContain(HOOK_NAME);
    expect(code).toMatch(/375:\s*['"]Hi mobile['"]/);
    expect(code).not.toMatch(/768:\s*['"]/);
  });

  test('hook definition is added once even with multiple overridden nodes', () => {
    let code = `'use client';
import React from 'react';
export default function Page() {
  return (
    <div>
      <p data-id="a">A</p>
      <p data-id="b">B</p>
    </div>
  );
}`;
    code = setTextOverrideInCode(code, 'a', TABLET, PRIMARY, 'A-tablet');
    code = setTextOverrideInCode(code, 'b', TABLET, PRIMARY, 'B-tablet');
    expect(code.match(new RegExp(`function ${HOOK_NAME}`, 'g'))?.length).toBe(1);
  });

  test('non-existent nodeId is a no-op', () => {
    const out = setTextOverrideInCode(PLAIN, 'NOPE', TABLET, PRIMARY, 'x');
    expect(out).toBe(PLAIN);
  });

  test('emits viewport widths array as third arg to useResponsiveText', () => {
    const out = setTextOverrideInCode(PLAIN, 't1', TABLET, PRIMARY, 'Hi tablet', ALL_VPS);
    // Sorted ascending: 375, 768, 1440
    expect(out).toMatch(/\[\s*375\s*,\s*768\s*,\s*1440\s*\]/);
  });

  test('changing viewport widths propagates to every existing hook call', () => {
    let code = setTextOverrideInCode(PLAIN, 't1', TABLET, PRIMARY, 'A', ALL_VPS);
    // User adds an XL viewport at 1920 — pass the new full list with the
    // next override edit; every existing hook call's third arg should
    // reflect [375, 768, 1440, 1920].
    code = setTextOverrideInCode(code, 't1', MOBILE, PRIMARY, 'B', [375, 768, 1440, 1920]);
    expect(code).toMatch(/\[\s*375\s*,\s*768\s*,\s*1440\s*,\s*1920\s*\]/);
    expect(code).not.toMatch(/\[\s*375\s*,\s*768\s*,\s*1440\s*\](?![,\d])/); // no stale 3-element array
  });
});

describe('removeTextOverrideInCode', () => {
  test('removing last override unwraps and prunes hook function', () => {
    let code = setTextOverrideInCode(PLAIN, 't1', TABLET, PRIMARY, 'Hi tablet', ALL_VPS);
    code = removeTextOverrideInCode(code, 't1', TABLET, PRIMARY);
    expect(code).not.toContain(HOOK_NAME);
    expect(code).toContain('Hello');
  });
});

describe('getTextOverrideWidths', () => {
  test('plain element → empty array', () => {
    expect(getTextOverrideWidths(PLAIN, 't1')).toEqual([]);
  });

  test('returns numeric widths from the overrides object', () => {
    let code = setTextOverrideInCode(PLAIN, 't1', TABLET, PRIMARY, 'Hi tablet', ALL_VPS);
    code = setTextOverrideInCode(code, 't1', MOBILE, PRIMARY, 'Hi mobile');
    const widths = getTextOverrideWidths(code, 't1').sort((a, b) => b - a);
    expect(widths).toEqual([TABLET, MOBILE]);
  });

  test('non-existent nodeId → empty', () => {
    expect(getTextOverrideWidths(PLAIN, 'nope')).toEqual([]);
  });
});

describe('react import management', () => {
  test('augments existing react import when only React default is present', () => {
    const code = `'use client';
import React from 'react';
export default function Page() {
  return <p data-id="t1">Hi</p>;
}`;
    const out = setTextOverrideInCode(code, 't1', TABLET, PRIMARY, 'tablet');
    expect(out).toMatch(/import\s+React,\s*\{[^}]*useState[^}]*\}\s+from\s+['"]react['"]/);
  });

  test('adds named imports when react import has braces but missing names', () => {
    const code = `'use client';
import { Component } from 'react';
export default function Page() {
  return <p data-id="t1">Hi</p>;
}`;
    const out = setTextOverrideInCode(code, 't1', TABLET, PRIMARY, 'tablet');
    // Existing `Component` named import preserved; the hook deps + a default
    // `React` are added (React is needed because the hook uses
    // `React.createElement`).
    expect(out).toMatch(/import\s+React,\s*\{[^}]*Component[^}]*\}\s+from\s+['"]react['"]/);
    expect(out).toMatch(/import\s+[^;]*useState[^;]*from\s+['"]react['"]/);
    expect(out).toMatch(/import\s+[^;]*useRef[^;]*from\s+['"]react['"]/);
    expect(out).toMatch(/import\s+[^;]*useLayoutEffect[^;]*from\s+['"]react['"]/);
  });

  test('inserts a fresh react import when none exists', () => {
    const code = `'use client';
export default function Page() {
  return <p data-id="t1">Hi</p>;
}`;
    const out = setTextOverrideInCode(code, 't1', TABLET, PRIMARY, 'tablet');
    expect(out).toMatch(/import\s+React,\s*\{[^}]*useState[^}]*useRef[^}]*useLayoutEffect[^}]*\}\s+from\s+['"]react['"]/);
  });
});

// ── legacy hook-inside-fence self-heal ────────────────────────────────────────
// Files written before 2026-07-03 could carry the injected useMediaQuery hook
// INSIDE the @useResponsiveText fence (the old before-first-function anchor).
// Removing the last text override prunes the fence — the heal re-injects
// useMediaQuery when __mq gates still reference it (the "Reset Override →
// undefined useMediaQuery" live crash).
describe('fence prune — useMediaQuery self-heal', () => {
  const LEGACY = `'use client';
import React, { useState, useRef, useLayoutEffect, useEffect } from 'react';

// @useResponsiveText-begin
function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {}, [query]);
  return matches;
}

function useResponsiveText(primary, overrides, vpWidths) {
  return primary;
}
// @useResponsiveText-end

export default function Page() {
  const __mq0 = useMediaQuery('(max-width: 768px)');
  return (
    <div data-id="root">
      <svg data-id="t1-svg" viewBox={__mq0 ? "0 0 1010 120" : "0 0 1010 78"} style={{width: '100%'}}>
        <foreignObject width="100%" height="100%"><p data-id="t1">{useResponsiveText('Hello', { 768: 'Hi' }, [375, 768, 1440])}</p></foreignObject>
      </svg>
    </div>
  );
}
`;

  test('re-injects useMediaQuery after pruning a fence that swallowed it', () => {
    // Removing the ONLY override unwraps the call → hook unused → fence pruned.
    const out = removeTextOverrideInCode(LEGACY, 't1', 768, 1440, [375, 768, 1440]);
    expect(out).not.toContain('@useResponsiveText-begin');   // fence gone
    expect(out).not.toContain('useResponsiveText(');          // call unwrapped
    expect(out).toContain('__mq0');                           // gate still used by viewBox
    expect(out).toMatch(/function\s+useMediaQuery\b/);        // hook re-injected (self-heal)
  });
});

// ─── Whole-text typography-mark routing (the shadowed font-size bug) ────────
import { splitTypographyMarkFromOverride } from './text-override-gen';

describe('whole-text typography mark routing', () => {
  const PAGE_WITH_STYLE = `'use client';
import React from 'react';
export default function Page() {
  return <div data-id="root">
    <style>{\`
    @media (max-width: 375px) {
      [data-id="t1"] { width: 270px !important; }
    }
  \`}</style>
    <p data-id="t1" style={{ fontSize: '68px' }}>Hello</p>
  </div>;
}`;

  test('a whole-text font-size span routes to the band and stores plain text (the aBode hero shadow)', () => {
    const out = setTextOverrideInCode(PAGE_WITH_STYLE, 't1', MOBILE, PRIMARY,
      '<span style="font-size: 40px;">Hello mobile</span>', ALL_VPS);
    // Stored override is PLAIN text — the mark never enters the content channel,
    // so it can't shadow later panel font-size writes for that viewport.
    expect(out).toMatch(/375:\s*['"]Hello mobile['"]/);
    expect(out).not.toMatch(/375:\s*['"]<span/);
    // The font-size landed in the mobile band instead — the panel's own write.
    expect(out).toMatch(/\[data-id="t1"\][^}]*font-size: 40px !important/);
  });

  test('per-run marks (partial or nested spans) pass through untouched', () => {
    const partial = 'Hello <span style="color: red;">world</span>';
    const out = setTextOverrideInCode(PAGE_WITH_STYLE, 't1', MOBILE, PRIMARY, partial, ALL_VPS);
    expect(out).toContain('color: red');
    expect(out).not.toMatch(/\[data-id="t1"\][^}]*color: red !important/);

    const nested = '<span style="font-size: 40px;">Hello <span style="color: red;">w</span></span>';
    expect(splitTypographyMarkFromOverride(nested).styles).toEqual({});
  });

  test('non-typography props stay on the span; typography routes off it', () => {
    const split = splitTypographyMarkFromOverride('<span style="font-size: 40px; background-color: yellow;">Hi</span>');
    expect(split.styles).toEqual({ fontSize: '40px' });
    expect(split.text).toBe('<span style="background-color: yellow;">Hi</span>');
    // Fully-typographic span unwraps entirely.
    const clean = splitTypographyMarkFromOverride('<span style="font-size: 40px; color: #fff;">Hi</span>');
    expect(clean.styles).toEqual({ fontSize: '40px', color: '#fff' });
    expect(clean.text).toBe('Hi');
  });

  test('primary edits are never routed (base flatten owns that path)', () => {
    const out = setTextOverrideInCode(PAGE_WITH_STYLE, 't1', PRIMARY, PRIMARY,
      '<span style="font-size: 40px;">Hello</span>', ALL_VPS);
    // Whatever the primary path does with the HTML, no band write happens.
    expect(out).not.toMatch(/font-size: 40px !important/);
  });
});

describe('primary writes never ship raw TipTap HTML (string-style crash, 2026-08-31)', () => {
  // Real user site down: `<span style="font-size: 53px;">` landed in base JSX
  // children as a STRING style attribute — invisible on the canvas, fatal in
  // React DOM ("The style prop expects a mapping…"). Two writers did it:
  // the reset-last-override UNWRAP and the unwrapped-primary edit.

  const MARKED = '<span style="font-size: 53px;">Manage all your hospitality needs.</span>';

  test('unwrapped primary edit with a mark → JSX object style, never string', () => {
    const out = setTextOverrideInCode(PLAIN, 't1', PRIMARY, PRIMARY, MARKED, ALL_VPS);
    expect(out).not.toMatch(/style="/);
    expect(out).toMatch(/fontSize:\s*['"]53px['"]/);
    expect(out).toContain('Manage all your hospitality needs.');
  });

  test('reset of the LAST override unwraps with converted children (the exact user repro)', () => {
    // Step 1: replica edit wraps the node.
    let code = setTextOverrideInCode(PLAIN, 't1', TABLET, PRIMARY, 'Hi tablet', ALL_VPS);
    // Step 2: primary rich edit stores TipTap HTML as the hook's primary arg.
    code = setTextOverrideInCode(code, 't1', PRIMARY, PRIMARY, MARKED, ALL_VPS);
    expect(code).toContain('font-size: 53px'); // safely inside the string arg
    // Step 3: reset the last override → unwrap must CONVERT, not dump raw.
    const out = removeTextOverrideInCode(code, 't1', TABLET, PRIMARY, ALL_VPS);
    expect(out).not.toMatch(/style="/);
    expect(out).toMatch(/fontSize:\s*['"]53px['"]/);
    expect(out).toContain('Manage all your hospitality needs.');
  });

  test('plain-text unwrap unchanged', () => {
    let code = setTextOverrideInCode(PLAIN, 't1', TABLET, PRIMARY, 'Hi tablet', ALL_VPS);
    code = setTextOverrideInCode(code, 't1', PRIMARY, PRIMARY, 'Just words', ALL_VPS);
    const out = removeTextOverrideInCode(code, 't1', TABLET, PRIMARY, ALL_VPS);
    expect(out).toContain('Just words');
    expect(out).not.toContain(HOOK_NAME + '(');
  });

  test('multi-span TipTap payload converts every mark', () => {
    const html = '<span style="color: #ff0000; font-size: 36px;">​</span><span style="font-size: 36px;">Hello</span>';
    const out = setTextOverrideInCode(PLAIN, 't1', PRIMARY, PRIMARY, html, ALL_VPS);
    expect(out).not.toMatch(/style="/);
    expect(out).toMatch(/fontSize:\s*['"]36px['"]/);
    expect(out).toContain('Hello');
  });

  test('malformed HTML falls back to stripped plain text — content never wiped', () => {
    const out = setTextOverrideInCode(PLAIN, 't1', PRIMARY, PRIMARY, '<span style="x: {bad">Keep me</span', ALL_VPS);
    expect(out).toContain('Keep me');
    expect(out).not.toMatch(/style="/);
  });
});

describe('wrap preserves marked desktop text (blank-primary bug, 2026-08-31)', () => {
  // Minutes after the raw-HTML fix: typing the FIRST tablet override on a node
  // whose desktop text lived in <span style={{ fontSize: '47px' }}> stored the
  // hook primary as "" — the desktop text vanished. Wrap must serialize the
  // existing children into the hook's HTML dialect, not flatten marks to ''.
  const MARKED_PAGE = `'use client';
import React from 'react';
export default function Page() {
  return <p data-id="t1"><span style={{ fontSize: '47px' }}>Hello</span></p>;
}`;

  test('first override on a marked node keeps the desktop text + mark', () => {
    const out = setTextOverrideInCode(MARKED_PAGE, 't1', TABLET, PRIMARY, 'Hi tablet', ALL_VPS);
    expect(out).toMatch(/useResponsiveText\("<span style=\\"font-size: 47px;\\">Hello<\/span>"/);
    expect(out).toMatch(/768:\s*['"]Hi tablet['"]/);
  });

  test('full cycle: wrap marked → reset override → desktop children restored with the mark', () => {
    let code = setTextOverrideInCode(MARKED_PAGE, 't1', TABLET, PRIMARY, 'Hi tablet', ALL_VPS);
    const out = removeTextOverrideInCode(code, 't1', TABLET, PRIMARY, ALL_VPS);
    expect(out).not.toMatch(/style="/);
    expect(out).toMatch(/fontSize:\s*['"]47px['"]/);
    expect(out).toContain('Hello');
    expect(out).not.toContain(HOOK_NAME + '(');
  });

  test('unsupported child shapes keep their text (tag dropped, never blanked)', () => {
    const page = `'use client';
import React from 'react';
export default function Page() {
  return <p data-id="t1"><strong>Bold bit</strong> and tail</p>;
}`;
    const out = setTextOverrideInCode(page, 't1', TABLET, PRIMARY, 'Hi', ALL_VPS);
    expect(out).toMatch(/useResponsiveText\("[^"]*Bold bit[^"]*and tail/);
  });

  test('multi-line marked text serializes br and round-trips', () => {
    const page = `'use client';
import React from 'react';
export default function Page() {
  return <p data-id="t1"><span style={{ fontSize: '20px' }}>Line one<br />Line two</span></p>;
}`;
    let code = setTextOverrideInCode(page, 't1', TABLET, PRIMARY, 'Hi', ALL_VPS);
    expect(code).toContain('Line one<br>Line two');
    const out = removeTextOverrideInCode(code, 't1', TABLET, PRIMARY, ALL_VPS);
    expect(out).toContain('Line one');
    expect(out).toContain('Line two');
    expect(out).not.toMatch(/style="/);
  });
});
