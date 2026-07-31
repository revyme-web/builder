// Tests for the preset-usage scanner.
//
// These tests pin the contract behind the count badge + jump-to-node popup
// in the LibraryPanel preset rows. The scanner is a pure helper (no atom,
// no projectFS) so we just feed it a `Map<filePath, source>` directly.
//
// The scanner exists because the parser-derived `node.styles` map only
// captures inline `style={{…}}` properties. `var(--token)` references in
// motion variant objects, `@media` overrides, or motion props slip
// through that path silently — the user's BRAND preset is on a hero with
// `backgroundColor: 'var(--color-brand)'`, but the badge stayed empty
// until we switched to a raw-source regex scan. Tests below cover every
// known reference site so a future regression on this surfaces here.

import { describe, test, expect } from 'vitest';
import { scanPresetUsage, findEnclosingDataId, deriveFileLabel } from './preset-store';

describe('scanPresetUsage — basic detection', () => {
  test('finds a single var() in inline JSX style', () => {
    const code = `
      export default function Page() {
        return <div data-id="hero" style={{ backgroundColor: 'var(--color-brand)' }}/>;
      }
    `;
    const usage = scanPresetUsage(new Map([['app/page.tsx', code]]));
    expect(usage.has('color-brand')).toBe(true);
    const list = usage.get('color-brand')!;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      filePath: 'app/page.tsx',
      nodeId: 'hero',
      fileLabel: 'Home',
    });
  });

  test('finds var() inside compound shorthand (border, gradient, …)', () => {
    const code = `
      export default function Page() {
        return <div data-id="card" style={{
          border: '1px solid var(--color-brand)',
          background: 'linear-gradient(to right, var(--color-brand), var(--color-accent))'
        }}/>;
      }
    `;
    const usage = scanPresetUsage(new Map([['app/page.tsx', code]]));
    // Same node uses both — we want each token to record exactly one entry
    // for this node (badge counts NODES, not raw matches).
    expect(usage.get('color-brand')).toHaveLength(1);
    expect(usage.get('color-accent')).toHaveLength(1);
  });

  test('tolerates fallback syntax `var(--name, fallback)`', () => {
    const code = `
      export default function Page() {
        return <div data-id="hero" style={{ color: 'var(--color-brand, #ec4899)' }}/>;
      }
    `;
    const usage = scanPresetUsage(new Map([['app/page.tsx', code]]));
    expect(usage.get('color-brand')).toHaveLength(1);
  });

  test('tolerates whitespace inside the var() parens', () => {
    const code = `
      export default function Page() {
        return <div data-id="hero" style={{ color: 'var( --color-brand )' }}/>;
      }
    `;
    const usage = scanPresetUsage(new Map([['app/page.tsx', code]]));
    expect(usage.get('color-brand')).toHaveLength(1);
  });
});

describe('scanPresetUsage — non-style locations', () => {
  // The whole point of the rewrite: var() refs can live in places the
  // parser's `node.styles` map doesn't cover. These tests pin those.

  test('detects var() in framer-motion variant objects', () => {
    const code = `
      const heroVariants = {
        default: { backgroundColor: 'var(--color-brand)' },
        hover:   { backgroundColor: 'var(--color-accent)' },
      };
      export default function Page() {
        return <motion.div data-id="hero" variants={heroVariants}/>;
      }
    `;
    const usage = scanPresetUsage(new Map([['components/Hero.tsx', code]]));
    expect(usage.get('color-brand')).toHaveLength(1);
    expect(usage.get('color-accent')).toHaveLength(1);
  });

  test('detects var() in @media query CSS strings', () => {
    const code = `
      export default function Page() {
        return (
          <div data-id="root">
            <style>{\`
              @media (max-width: 768px) {
                [data-id="title"] { color: var(--color-brand) !important; }
              }
            \`}</style>
            <h1 data-id="title">Hi</h1>
          </div>
        );
      }
    `;
    const usage = scanPresetUsage(new Map([['app/page.tsx', code]]));
    expect(usage.has('color-brand')).toBe(true);
    // Happy accident — the CSS selector's `[data-id="title"]` tokens are
    // textually closer to the `var()` call than the wrapping JSX
    // `data-id="root"`, so the walker attributes the match to "title".
    // That's actually the more useful answer (the CSS rule targets that
    // node) so we lock it in here.
    expect(usage.get('color-brand')![0].nodeId).toBe('title');
  });

  test('detects var() in motion prop values (whileHover, whileTap, etc.)', () => {
    const code = `
      export default function Page() {
        return <motion.div
          data-id="btn"
          whileHover={{ backgroundColor: 'var(--color-brand)' }}
        />;
      }
    `;
    const usage = scanPresetUsage(new Map([['app/page.tsx', code]]));
    expect(usage.get('color-brand')).toHaveLength(1);
    expect(usage.get('color-brand')![0].nodeId).toBe('btn');
  });
});

describe('scanPresetUsage — file/node attribution', () => {
  test('aggregates the same token across multiple files', () => {
    const usage = scanPresetUsage(new Map([
      ['app/page.tsx',           `<div data-id="hero" style={{color:'var(--color-brand)'}}/>`],
      ['app/about/page.tsx',     `<div data-id="hero2" style={{color:'var(--color-brand)'}}/>`],
      ['components/Card.tsx',    `<div data-id="card" style={{color:'var(--color-brand)'}}/>`],
    ]));
    const list = usage.get('color-brand')!;
    expect(list).toHaveLength(3);
    expect(list.map(u => u.fileLabel).sort()).toEqual(['/about', 'Card', 'Home']);
  });

  test('skips layout files (their nodes are merged into pages)', () => {
    // If we walked layouts independently every layout-resident token would
    // surface twice — once under the layout, once under each page that
    // expansion drops it into.
    const usage = scanPresetUsage(new Map([
      ['app/layout.tsx',         `<div data-id="shell" style={{color:'var(--color-brand)'}}/>`],
      ['app/LayoutClient.tsx',   `<div data-id="shell2" style={{color:'var(--color-brand)'}}/>`],
    ]));
    expect(usage.size).toBe(0);
  });

  test('skips files outside app/ + components/', () => {
    // The scanner is intentionally narrow. CMS data, lib helpers, and other
    // non-design files can't host a renderable var() reference and would
    // pollute the count if we walked them.
    const usage = scanPresetUsage(new Map([
      ['lib/util.ts',  `const x = 'var(--color-brand)';`],
      ['cms/team.ts',  `const y = 'var(--color-brand)';`],
    ]));
    expect(usage.size).toBe(0);
  });

  test('attributes a var() to its enclosing data-id, not a sibling', () => {
    // The walker scans for the LAST data-id BEFORE the match offset. If a
    // sibling appears textually after a parent's `data-id` but before the
    // var(), we want the sibling, not the parent.
    const code = `
      export default function Page() {
        return (
          <div data-id="parent">
            <div data-id="child" style={{ color: 'var(--color-brand)' }}/>
          </div>
        );
      }
    `;
    const usage = scanPresetUsage(new Map([['app/page.tsx', code]]));
    expect(usage.get('color-brand')![0].nodeId).toBe('child');
  });

  test('falls back to __file__ for var() outside any data-id', () => {
    // E.g. a token defined in a top-level constant that the JSX consumes.
    const code = `
      const brand = 'var(--color-brand)';
      export default function Page() {
        return <div data-id="hero" style={{ color: brand }}/>;
      }
    `;
    const usage = scanPresetUsage(new Map([['app/page.tsx', code]]));
    // The const reference is recorded as __file__, the data-id="hero" var()
    // would NOT be a separate match (no var() string in the JSX itself).
    // So we expect ONE entry for `color-brand` with nodeId = __file__.
    const list = usage.get('color-brand')!;
    expect(list).toHaveLength(1);
    expect(list[0].nodeId).toBe('__file__');
  });
});

describe('scanPresetUsage — dedupe', () => {
  test('counts a node once even when it references the same token multiple times', () => {
    // Border + color both pointing at brand should still count as 1 node.
    const code = `
      export default function Page() {
        return <div data-id="hero" style={{
          color: 'var(--color-brand)',
          borderColor: 'var(--color-brand)',
          backgroundImage: 'linear-gradient(var(--color-brand), var(--color-brand))'
        }}/>;
      }
    `;
    const usage = scanPresetUsage(new Map([['app/page.tsx', code]]));
    expect(usage.get('color-brand')).toHaveLength(1);
  });
});

describe('scanPresetUsage — robustness', () => {
  test('skips files where parseJSXToNodes throws', () => {
    // Malformed JSX shouldn't kill the whole scan — the badge for OTHER
    // files should still resolve.
    const usage = scanPresetUsage(new Map([
      ['app/broken.tsx', `export default function Broken() { return <div data-id="x" style={{`],
      ['app/page.tsx',   `export default function Page() { return <div data-id="hero" style={{color:'var(--color-brand)'}}/>; }`],
    ]));
    // `app/page.tsx` finds its match.
    expect(usage.get('color-brand')!.some(u => u.filePath === 'app/page.tsx')).toBe(true);
  });

  test('still records var() matches from a file whose AST parse failed', () => {
    // Even if the parser couldn't surface node names, the regex walker
    // can still build accurate counts (with `nodeName = fileLabel` as
    // fallback). Without this, a syntax error in one file silently
    // erases its preset-usage badge.
    const code = `
      // Unclosed JSX expression below trips the parser.
      export default function Broken() {
        return <div data-id="hero" style={{ color: 'var(--color-brand)'
      }
    `;
    const usage = scanPresetUsage(new Map([['app/page.tsx', code]]));
    // The exact attribution may degrade, but the token must still appear
    // — silence here would mean a broken page hides its preset usage.
    expect(usage.has('color-brand')).toBe(true);
  });

  test('returns an empty map for an empty file set', () => {
    expect(scanPresetUsage(new Map()).size).toBe(0);
  });
});

describe('findEnclosingDataId', () => {
  test('returns the most recent data-id before offset', () => {
    const code = `<div data-id="a"><div data-id="b">X</div></div>`;
    const offset = code.indexOf('X');
    expect(findEnclosingDataId(code, offset)).toBe('b');
  });

  test('returns null when no data-id appears before offset', () => {
    const code = `function Foo() { const x = 'var(--brand)'; }`;
    const offset = code.indexOf('var(');
    expect(findEnclosingDataId(code, offset)).toBeNull();
  });

  test('handles single-quoted attribute too', () => {
    // The regex pin is double quotes (which is the Babel/codegen default).
    // Single-quoted should NOT match — pinning behavior so we know if
    // code generation ever changes the quoting style.
    const code = `<div data-id='x'><span>hit</span></div>`;
    const offset = code.indexOf('hit');
    expect(findEnclosingDataId(code, offset)).toBeNull();
  });
});

describe('deriveFileLabel', () => {
  test.each([
    ['app/page.tsx', 'Home'],
    ['app/about/page.tsx', '/about'],
    ['app/team/[slug]/page.tsx', '/team/[slug]'],
    ['components/Hero.tsx', 'Hero'],
    ['components/embeds/YouTubeEmbed.tsx', 'embeds/YouTubeEmbed'],
  ])('%s → %s', (input, expected) => {
    expect(deriveFileLabel(input)).toBe(expected);
  });

  test('falls back to the raw path for unusual structures', () => {
    expect(deriveFileLabel('lib/util.ts')).toBe('lib/util.ts');
  });
});
