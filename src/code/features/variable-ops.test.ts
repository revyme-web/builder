import { describe, test, expect } from 'vitest';
import { parseJSXToNodes } from '../parsing/parser';
import {
  createVariableInCode,
  removeVariableInCode,
  setBorderOverlayVariableForVariant,
  setInlineVariableForVariant,
  setComponentPropDefaultInCode,
  detectValueSource,
  BORDER_LONGHANDS,
  createTextVariableInCode,
  bindTextNodeAsPageVarInCode,
  removeTextVariableInCode,
  addBarePropToFunctionInCode,
  createLinkAttrVariableInCode,
  removeLinkAttrVariableInCode,
  createTypedVariableInCode,
  createConditionalVariableInCode,
  deleteComponentVariableInCode,
  renameComponentVariableInCode,
  hoistMapBindingsToProps,
} from './variable-ops';
import { parseJSX } from '../parsing/ast-utils';
import { removePageVariableInCode } from './page-variables';

describe('deleteComponentVariableInCode — retroactive full removal', () => {
  test('strips the deleted variable @propMeta entry too (no orphan in the panel)', () => {
    const code = `'use client';
/** @propMeta {"headerVariant":{"label":"Nav"},"stbVar":{"variantOf":"StartTrialButton"}} */
export default function L({ children, stbVar = "default" }) {
  return <div><Btn initialVariant={stbVar} />{children}</div>;
}`;
    const out = deleteComponentVariableInCode(code, 'stbVar', 'default');
    expect(out).not.toContain('stbVar');             // param + usage + @propMeta entry all gone
    expect(out).toContain('"headerVariant"');         // unrelated @propMeta entries preserved
  });

  test('inlines every style ref to the default and drops the prop', () => {
    const code = `function Card({ style, bd = "1px solid red" }) {
  return <div data-id="root">
    <div data-id="a" style={{ border: bd }}></div>
    <div data-id="b" style={{ border: bd, color: 'blue' }}></div>
  </div>;
}`;
    const out = deleteComponentVariableInCode(code, 'bd');
    // No dangling `bd` identifier references.
    expect(out).not.toMatch(/border:\s*bd\b/);
    expect(out).not.toMatch(/\bbd\s*=/);            // prop removed from signature
    // Refs inlined to the default literal.
    expect(out).toMatch(/border:\s*["']1px solid red["']/);
    expect(out).toMatch(/color:\s*'blue'/);          // untouched
    expect(parseJSX(out)).not.toBeNull();
  });

  test('removes a withCursor(prop, …) spread and the prop', () => {
    const code = `function Card({ myCursor = () => null }) {
  return <div data-id="root" {...withCursor(myCursor, { mode: 'replace' })}></div>;
}`;
    const out = deleteComponentVariableInCode(code, 'myCursor');
    expect(out).not.toContain('withCursor(myCursor');
    expect(out).not.toMatch(/\bmyCursor\b/);
    expect(parseJSX(out)).not.toBeNull();
  });

  test('resolves a per-variant ternary ref', () => {
    const code = `function Card({ initialVariant = 'default', c = '#fff' }) {
  return <div data-id="a" style={{ backgroundColor: initialVariant === 'v' ? c : '#000' }}></div>;
}`;
    const out = deleteComponentVariableInCode(code, 'c');
    expect(out).not.toMatch(/\?\s*c\s*:/);
    expect(out).toMatch(/"#fff"/);
    expect(out).not.toMatch(/\bc\s*=/);
  });

  test('inlines a TEXT-content reference (bare and per-variant ternary) — no dangling identifier', () => {
    const code = `function Card({ initialVariant = 'default', content = 'Hello' }) {
  return <div data-id="root">
    <p data-id="a">{content}</p>
    <p data-id="b">{initialVariant === 'variant-2' ? 'Hi' : content}</p>
  </div>;
}`;
    const out = deleteComponentVariableInCode(code, 'content');
    expect(out).not.toMatch(/\bcontent\b/);  // prop + all refs gone
    expect(out).toMatch(/['"]Hi['"]\s*:\s*['"]Hello['"]/); // ternary branch kept, fallback inlined
    expect(parseJSX(out)).not.toBeNull();
  });

  test('deletes a SCROLL SECTION var — reverts getElementById/deps + drops route-map reassignment + JSON sectionVar', () => {
    const code = `function LayoutClient({ scrollSection = "hero" }) {
  scrollSection = __tp.scrollSection ?? scrollSection;
  useEffect(() => { ref.current = document.getElementById(scrollSection); }, [scrollSection]);
  return <Header data-scroll-variant='{"trigger":"sectionInView","sections":[{"sectionId":"hero","to":"x","sectionVar":"scrollSection"}]}' />;
}`;
    const out = deleteComponentVariableInCode(code, 'scrollSection');
    expect(out).not.toMatch(/\bscrollSection\b/);             // every ref + the param gone
    expect(out).toContain("document.getElementById('hero')"); // reverted to the literal default
    expect(out).toContain('}, [])');                          // deps array emptied
    expect(out).not.toContain('__tp.');                       // route-map reassignment removed
    expect(out).not.toContain('"sectionVar"');               // JSON entry dropped
    expect(out).toContain('"sectionId":"hero"');             // sibling JSON keys intact
    expect(parseJSX(out)).not.toBeNull();
  });

  test('inlines a per-viewport component-INSTANCE PROP binding (the bug: mass-delete left dangling refs)', () => {
    const code = `function LayoutClient({ padding = "46px", padding1 = "80px", v = "default", v2 = "variant-1" }) {
  const __mq2 = useMediaQuery('(max-width: 768px) and (min-width: 376px)');
  return <div data-id="root"><KuWoCo data-id="k" padding={__mq2 ? padding1 : padding} /><WoXiKa data-id="w" initialVariant={(__mq2 ? v2 : v)} /></div>;
}`;
    // Delete all four vars in sequence (what bulk-delete does), each inlining its own ref.
    let out = code;
    for (const [name] of [['padding1'], ['padding'], ['v2'], ['v']]) out = deleteComponentVariableInCode(out, name);
    // No dangling identifiers — every per-viewport prop ref is inlined to a literal.
    expect(out).toMatch(/LayoutClient\(\{\}\)/);                          // all 4 params removed
    expect(out).not.toMatch(/\bpadding1\b/);                             // the var ref is gone (attr NAME `padding=` is fine)
    expect(out).not.toMatch(/\? v2 : v\b/);                              // variant refs gone
    expect(out).toMatch(/padding=\{__mq2 \? "80px" : "46px"\}/);          // both branches now literals
    expect(out).toMatch(/initialVariant=\{\(?__mq2 \? "variant-1" : "default"\)?\}/); // parens optional (babel may drop)
    expect(parseJSX(out)).not.toBeNull();                                 // valid → oracle won't block
  });

  test('on a TEMPLATE, the @pageVariables JSON entry is stripped too (no orphan in the modal)', () => {
    // Mirrors the deleteComponentVariable mutation: deleteComponentVariableInCode (param + binding)
    // THEN removePageVariableInCode (the @pageVariables comment — the modal's source of truth).
    const code = `/** @pageVariables { "variables": [ { "name": "padding", "type": "number", "default": "46px" }, { "name": "keepme", "type": "text", "default": "x" } ] } */
function LayoutClient({ padding = "46px", keepme = "x" }) {
  const __mq2 = useMediaQuery('(max-width: 768px) and (min-width: 376px)');
  return <div data-id="root"><KuWoCo data-id="k" padding={__mq2 ? padding : padding} /></div>;
}`;
    let out = deleteComponentVariableInCode(code, 'padding');
    out = removePageVariableInCode(out, 'padding');
    expect(out).not.toMatch(/"name":\s*"padding"/);                      // @pageVariables entry gone (the orphan fix)
    expect(out).toMatch(/"name":\s*"keepme"/);                           // sibling kept
    expect(out).toMatch(/LayoutClient\(\{ keepme/);                      // param gone
    expect(parseJSX(out)).not.toBeNull();
  });
});

describe('renameComponentVariableInCode', () => {
  test('renames the prop AND its references (scope-aware)', () => {
    const code = `function Card({ bd = "1px solid red" }) {
  return <div data-id="a" style={{ border: bd }}></div>;
}`;
    const out = renameComponentVariableInCode(code, 'bd', 'cardBorder');
    expect(out).toMatch(/cardBorder\s*=\s*"1px solid red"/);
    expect(out).toMatch(/border:\s*cardBorder\b/);
    expect(out).not.toMatch(/\bbd\b/);
    expect(parseJSX(out)).not.toBeNull();
  });

  test('renaming a section var ALSO syncs the data-scroll-variant JSON sectionVar', () => {
    const code = `function LayoutClient({ scrollSection = "hero" }) {
  useEffect(() => { ref.current = document.getElementById(scrollSection); }, [scrollSection]);
  return <Header data-scroll-variant='{"trigger":"sectionInView","sections":[{"sectionId":"hero","to":"x","sectionVar":"scrollSection"}]}' />;
}`;
    const out = renameComponentVariableInCode(code, 'scrollSection', 'heroSection');
    expect(out).toMatch(/getElementById\(heroSection\)/);            // identifier ref renamed
    expect(out).toContain('"sectionVar":"heroSection"');             // JSON string synced
    expect(out).not.toContain('"sectionVar":"scrollSection"');
  });

  test('no-op for empty / unchanged / structural target', () => {
    const code = `function Card({ bd = "x" }) { return <div data-id="a" style={{ border: bd }}></div>; }`;
    expect(renameComponentVariableInCode(code, 'bd', '')).toBe(code);
    expect(renameComponentVariableInCode(code, 'bd', 'bd')).toBe(code);
    expect(renameComponentVariableInCode(code, 'bd', 'style')).toBe(code);
  });
});

describe('createTypedVariableInCode', () => {
  const base = `function Card({ style }) {\n  return <div data-id="root" style={{ ...style }}></div>;\n}`;

  test('string variable → quoted literal default', () => {
    const out = createTypedVariableInCode(base, 'title', 'string', 'Hello');
    expect(out).toMatch(/title\s*=\s*["']Hello["']/);
    expect(parseJSX(out)).not.toBeNull();
  });

  test('number variable → UNQUOTED numeric literal', () => {
    const out = createTypedVariableInCode(base, 'count', 'number', '5');
    expect(out).toMatch(/count\s*=\s*5\b/);
    expect(out).not.toMatch(/count\s*=\s*["']5["']/);
  });

  test('boolean variable → unquoted boolean literal', () => {
    const out = createTypedVariableInCode(base, 'visible', 'boolean', 'true');
    expect(out).toMatch(/visible\s*=\s*true\b/);
  });

  test('refuses structural prop names', () => {
    expect(createTypedVariableInCode(base, 'style', 'string', 'x')).toBe(base);
    expect(createTypedVariableInCode(base, 'initialVariant', 'string', 'x')).toBe(base);
  });

  test('idempotent — leaves an existing prop alone', () => {
    const withProp = createTypedVariableInCode(base, 'count', 'number', '5');
    const again = createTypedVariableInCode(withProp, 'count', 'number', '99');
    expect(again).toMatch(/count\s*=\s*5\b/); // unchanged
  });

  test('inserts the new prop BEFORE ...rest (rest element must be last)', () => {
    // Masters that forward DOM props carry `...rest`; a new prop pushed AFTER it
    // emits `{ …, ...rest, content }` → "Rest element must be last element" and
    // crashes every later parse/mutation (the live setComponentPropLabel bug).
    const withRest = `function Card({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {\n  return <div data-id="root" {...rest} style={{ ...style }}>Hi</div>;\n}`;
    const out = createTypedVariableInCode(withRest, 'content', 'string', 'Hello');
    expect(parseJSX(out)).not.toBeNull(); // would be null if rest weren't last
    const sig = out.match(/function Card\(\{([^}]*)\}/)![1];
    expect(sig).toContain('content');
    expect(sig.indexOf('content')).toBeLessThan(sig.indexOf('...rest'));
  });

  test('adds the prop to the COMPONENT, never a nested empty-param arrow (the ({}) =>  crash)', () => {
    // A template/responsive helper carries `useState(() => …)`. The prop-add
    // traversal must NOT target that nested empty-param initializer arrow
    // (which would become `({ x = … }) =>` → and after a delete `({}) =>` →
    // "Cannot destructure undefined" at render). It must land on the
    // module-scope component function instead.
    const code = `function useMediaQuery(query) {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  return m;
}
export default function LayoutClient({ children, scrollSection3 = "" }) {
  const mq = useMediaQuery('(max-width: 768px)');
  return <div data-id="root">{children}</div>;
}`;
    const out = createTypedVariableInCode(code, 'myColor', 'string', '#fff');
    expect(parseJSX(out)).not.toBeNull();
    // The useState initializer arrow stays param-less — NOT corrupted.
    expect(out).toContain('useState(() =>');
    expect(out).not.toMatch(/useState\(\(\{/);
    // The prop landed on the LayoutClient signature.
    expect(out).toMatch(/function LayoutClient\(\{[^}]*myColor/);
  });
});

describe('setComponentPropDefaultInCode literalKind', () => {
  const code = `function Card({ count = 5, on = true, title = "hi" }) { return null; }`;
  test('number default stays unquoted', () => {
    const out = setComponentPropDefaultInCode(code, 'count', '10', 'number');
    expect(out).toMatch(/count\s*=\s*10\b/);
    expect(out).not.toMatch(/count\s*=\s*["']10["']/);
  });
  test('boolean default unquoted', () => {
    const out = setComponentPropDefaultInCode(code, 'on', 'false', 'boolean');
    expect(out).toMatch(/on\s*=\s*false\b/);
  });
  test('string default quoted (default kind)', () => {
    const out = setComponentPropDefaultInCode(code, 'title', 'bye');
    expect(out).toMatch(/title\s*=\s*["']bye["']/);
  });
});

// ─── detectValueSource ──────────────────────────────────────────────────────

describe('detectValueSource', () => {
  test('detects inline value (plain string)', () => {
    const result = detectValueSource('#1a1a2e');
    expect(result).toEqual({ source: 'inline', ref: null });
  });

  test('detects inline value for numeric string', () => {
    const result = detectValueSource('10px');
    expect(result).toEqual({ source: 'inline', ref: null });
  });

  test('detects inline value for empty string', () => {
    const result = detectValueSource('');
    expect(result).toEqual({ source: 'inline', ref: null });
  });

  test('detects prop (var: prefix)', () => {
    const result = detectValueSource('var:bgColor');
    expect(result).toEqual({ source: 'prop', ref: 'bgColor' });
  });

  test('detects prop with complex name', () => {
    const result = detectValueSource('var:headerBackgroundColor');
    expect(result).toEqual({ source: 'prop', ref: 'headerBackgroundColor' });
  });

  test('detects token (token: prefix)', () => {
    const result = detectValueSource('token:colors.primary');
    expect(result).toEqual({ source: 'token', ref: 'colors.primary' });
  });

  test('detects token with nested path', () => {
    const result = detectValueSource('token:theme.colors.bg.dark');
    expect(result).toEqual({ source: 'token', ref: 'theme.colors.bg.dark' });
  });

  test('does not misdetect strings containing "var:" in the middle', () => {
    const result = detectValueSource('some-var:value');
    expect(result).toEqual({ source: 'inline', ref: null });
  });
});

// ─── createVariableInCode ───────────────────────────────────────────────────

describe('createVariableInCode', () => {
  // Note: @babel/generator outputs double quotes for newly-created string literals,
  // so assertions use quote-agnostic regex patterns.

  const baseCode = `export default function Card() {
  return (
    <div data-id="node-1" style={{ backgroundColor: '#1a1a2e', padding: '20px' }}>
      <span data-id="node-2" style={{ color: 'red' }}>Hello</span>
    </div>
  );
}`;

  test('extracts existing inline string value to prop', () => {
    const result = createVariableInCode(baseCode, 'node-1', 'backgroundColor', 'bgColor');

    // The style should now reference bgColor identifier instead of string literal
    expect(result).toContain('backgroundColor: bgColor');
    // The prop should be added to function params with default value (babel uses double quotes)
    expect(result).toMatch(/bgColor\s*=\s*["']#1a1a2e["']/);
    // Original string literal should be removed from style
    expect(result).not.toMatch(/backgroundColor:\s*['"]#1a1a2e['"]/);
    // Other props should be preserved
    expect(result).toContain('padding');
  });

  test('preserves other props in the style object', () => {
    const result = createVariableInCode(baseCode, 'node-1', 'backgroundColor', 'bgColor');
    expect(result).toMatch(/padding:\s*['"]20px['"]/);
  });

  test('literalKind "number" writes a RAW numeric prop default (strips units)', () => {
    const code = `export default function Card() {
  return <div data-id="n" style={{ opacity: '0.5', gap: '16px' }}></div>;
}`;
    // opacity → unitless 0.5
    const op = createVariableInCode(code, 'n', 'opacity', 'op', undefined, undefined, 'number');
    expect(op).toContain('opacity: op');
    expect(op).toMatch(/op\s*=\s*0\.5\b/);     // numeric literal, NOT '0.5'
    expect(op).not.toMatch(/op\s*=\s*['"]/);
    // gap '16px' → 16 (px re-applied by React at runtime)
    const gap = createVariableInCode(code, 'n', 'gap', 'g', undefined, undefined, 'number');
    expect(gap).toMatch(/g\s*=\s*16\b/);
    expect(gap).not.toMatch(/g\s*=\s*['"]/);
  });

  test('border variable with NO existing ::after CREATES the overlay (the user case)', () => {
    // Frame with an empty inline `border: ""` and an empty <style> block — no overlay yet. Creating
    // a border variable must CREATE the ::after overlay bound to a CSS var, and drop the inline border.
    const noOverlay = `function Frame({ style }) {
  return (
    <div data-id="n" style={{ position: 'absolute', backgroundColor: '#244e70', overflow: 'hidden', borderRadius: '171px', ...style, border: "" }}>
  <style>{\`
  \`}</style>
    </div>
  );
}`;
    const result = createVariableInCode(noOverlay, 'n', 'border', 'borda', '');
    expect(parseJSX(result)).not.toBeNull();
    // The ::after overlay was created and bound to the var.
    expect(result).toMatch(/\[data-id="n"\]::after\s*\{[\s\S]*border:\s*var\(--borda\)/);
    expect(result).toContain("content: ''");        // standard overlay scaffolding present
    expect(result).toContain('inset: 0');
    // Element sets the custom property; the inline `border` is gone.
    expect(result).toMatch(/['"]--borda['"]:\s*borda/);
    expect(result).not.toMatch(/[^-]\bborder:\s*(""|borda)/);
    // Prop added.
    expect(result).toMatch(/borda\s*=/);
  });

  test('border variable on an OVERLAY (::after) binds via a CSS custom property, not inline', () => {
    // Master with an overlay border. Creating a `border` variable must keep it an overlay: rewrite
    // the ::after to `border: var(--prop)` + set `'--prop': prop` on the element — NOT inline `border`.
    const overlayCode = `function Frame({ style }) {
  return (
    <div data-id="n" style={{ position: 'absolute', backgroundColor: '#244e70', overflow: 'hidden', ...style }}>
  <style>{\`
    [data-node-id="n"]::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  z-index: 1;
  border-width: 104px;
  border-style: solid;
  border-color: #000000;
    }
  \`}</style>
    </div>
  );
}`;
    const result = createVariableInCode(overlayCode, 'n', 'border', 'frameBorder', '104px solid #000000');
    expect(parseJSX(result)).not.toBeNull();
    // ::after now binds the var; the longhands are gone.
    expect(result).toMatch(/\[data-id="n"\]::after[\s\S]*border:\s*var\(--frameBorder\)/);   // migrated to data-id
    expect(result).not.toMatch(/border-width:\s*104px/);
    // Element sets the custom property to the prop (NOT an inline `border:`).
    expect(result).toMatch(/['"]--frameBorder['"]:\s*frameBorder/);
    expect(result).not.toMatch(/[^-]\bborder:\s*frameBorder/);
    // Kept overlay scaffolding.
    expect(result).toContain('border-radius: inherit');
    // Prop added with the current shorthand as default.
    expect(result).toMatch(/frameBorder\s*=\s*['"]104px solid #000000['"]/);
  });

  test('adds missing property with default value when property not in style', () => {
    const result = createVariableInCode(baseCode, 'node-1', 'borderRadius', 'radius', '8px');

    // Should add the property with an identifier
    expect(result).toContain('borderRadius: radius');
    // Should add prop to function signature with default
    expect(result).toMatch(/radius\s*=\s*["']8px["']/);
  });

  test('returns original code when default value is null for missing property', () => {
    // When the property doesn't exist and no defaultValue is provided (undefined),
    // currentValue stays null and the code is returned unchanged
    const result = createVariableInCode(baseCode, 'node-1', 'borderRadius', 'radius');
    expect(result).toBe(baseCode);
  });

  test('handles empty default value (empty string)', () => {
    // Empty string is !== null, so it should work
    const result = createVariableInCode(baseCode, 'node-1', 'borderRadius', 'radius', '');

    // Should add the property with identifier
    expect(result).toContain('borderRadius: radius');
    // Default should be empty string (babel uses double quotes)
    expect(result).toMatch(/radius\s*=\s*["']{2}/);
  });

  test('returns original code when node ID not found', () => {
    const result = createVariableInCode(baseCode, 'nonexistent', 'backgroundColor', 'bgColor');
    expect(result).toBe(baseCode);
  });

  test('refuses to bind a style onto the reserved initialVariant prop', () => {
    // Binding boxShadow onto initialVariant (the variant switcher) would corrupt
    // variant animation — guard must return the code untouched.
    const variantCode = `function Card({ initialVariant = "default" }) {
  return (
    <motion.div data-id="node-1" animate={initialVariant} style={{ boxShadow: '0px 4px 8px #000' }}>Hi</motion.div>
  );
}`;
    const result = createVariableInCode(variantCode, 'node-1', 'boxShadow', 'initialVariant');
    expect(result).toBe(variantCode);
    expect(result).not.toContain('boxShadow: initialVariant');
  });

  test('refuses to bind a style onto the structural style prop', () => {
    const result = createVariableInCode(baseCode, 'node-1', 'backgroundColor', 'style');
    expect(result).toBe(baseCode);
  });

  test('returns original code when style attribute is missing', () => {
    const code = `export default function Card() {
  return <div data-id="node-1">Hello</div>;
}`;
    const result = createVariableInCode(code, 'node-1', 'color', 'textColor');
    expect(result).toBe(code);
  });

  test('works with arrow function component', () => {
    const arrowCode = `const Card = () => {
  return (
    <div data-id="node-1" style={{ color: 'blue' }}>Hello</div>
  );
}`;
    const result = createVariableInCode(arrowCode, 'node-1', 'color', 'textColor');
    expect(result).toContain('color: textColor');
    expect(result).toMatch(/textColor\s*=\s*["']blue["']/);
  });

  test('adds to existing destructured params', () => {
    const codeWithProps = `export default function Card({ title = 'Hello' }) {
  return (
    <div data-id="node-1" style={{ backgroundColor: '#fff' }}>{title}</div>
  );
}`;
    const result = createVariableInCode(codeWithProps, 'node-1', 'backgroundColor', 'bgColor');
    // Should still have existing prop
    expect(result).toMatch(/title\s*=\s*['"]Hello['"]/);
    // Should also have the new prop
    expect(result).toMatch(/bgColor\s*=\s*["']#fff["']/);
  });

  test('returns original code for invalid/unparseable code', () => {
    const bad = 'not valid jsx at all {{{';
    const result = createVariableInCode(bad, 'node-1', 'color', 'c');
    expect(result).toBe(bad);
  });

  test('works on second nested node', () => {
    const result = createVariableInCode(baseCode, 'node-2', 'color', 'textColor');
    expect(result).toContain('color: textColor');
    expect(result).toMatch(/textColor\s*=\s*["']red["']/);
  });

  test('extracts a backtick template literal with no interpolation', () => {
    // Real-world case: shadow/gradient atoms format compound CSS values as
    // template strings even when there are no expressions. Without this the
    // user couldn't make a variable on Shadow values that happened to be
    // emitted with backticks.
    const code = `export default function Card() {
  return (
    <div data-id="node-1" style={{ boxShadow: \`0 1px 3px rgba(0,0,0,0.1)\` }}>Hello</div>
  );
}`;
    const result = createVariableInCode(code, 'node-1', 'boxShadow', 'cardShadow');
    expect(result).toContain('boxShadow: cardShadow');
    // Default value reflects the template's cooked text
    expect(result).toMatch(/cardShadow\s*=\s*["']0 1px 3px rgba\(0,0,0,0\.1\)["']/);
  });

  test('skips template literals with interpolations (cannot safely extract a static default)', () => {
    const code = `export default function Card({ color = 'red' }) {
  return (
    <div data-id="node-1" style={{ boxShadow: \`0 1px 3px \${color}\` }}>Hello</div>
  );
}`;
    const result = createVariableInCode(code, 'node-1', 'boxShadow', 'cardShadow');
    // Bails out — code unchanged
    expect(result).toBe(code);
  });

  test('clears Border longhands when creating a `border` shorthand variable', () => {
    // Border atom writes per-side longhands when sides differ + a border:''
    // empty shorthand to clear cascade conflicts. When the user makes border
    // a variable, those leftover longhands have to drop or they'd shadow the
    // bound shorthand on the canvas.
    const code = `export default function Card() {
  return (
    <div data-id="node-1" style={{
      borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: 'red',
      borderRightWidth: '1px', borderRightStyle: 'solid', borderRightColor: 'red',
      borderBottomWidth: '1px', borderBottomStyle: 'solid', borderBottomColor: 'red',
      borderLeftWidth: '1px', borderLeftStyle: 'solid', borderLeftColor: 'red',
      padding: '10px'
    }}>Hello</div>
  );
}`;
    const result = createVariableInCode(
      code, 'node-1', 'border', 'cardBorder', '1px solid red', BORDER_LONGHANDS,
    );

    // Bound shorthand inserted as Identifier
    expect(result).toContain('border: cardBorder');
    // Longhands removed
    expect(result).not.toMatch(/borderTopWidth/);
    expect(result).not.toMatch(/borderRightStyle/);
    expect(result).not.toMatch(/borderBottomColor/);
    expect(result).not.toMatch(/borderLeftWidth/);
    // Unrelated props untouched
    expect(result).toMatch(/padding:\s*['"]10px['"]/);
    // Function signature gains the prop with the shorthand default
    expect(result).toMatch(/cardBorder\s*=\s*["']1px solid red["']/);
  });

  test('uses caller-supplied defaultValue over the existing JSX value when both are present', () => {
    // The modal lets the user edit the default (e.g. via the embedded Shadow
    // popup). When the user changes it before clicking Create, that edited
    // value must land in the function signature — the JSX literal that
    // happened to be there before the variable existed is moot.
    const code = `export default function Card() {
  return (
    <div data-id="node-1" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>Hello</div>
  );
}`;
    const result = createVariableInCode(
      code, 'node-1', 'boxShadow', 'cardShadow',
      '0 4px 12px rgba(0,0,0,0.2)', // user-edited default from the modal
    );

    // Identifier replaces the inline literal in JSX
    expect(result).toContain('boxShadow: cardShadow');
    // Function signature uses the modal's value, not the original JSX literal
    expect(result).toMatch(/cardShadow\s*=\s*["']0 4px 12px rgba\(0,0,0,0\.2\)["']/);
    // The original JSX literal must be gone — both the value AND any leftover
    // copy of it. Using a quote-bracketed regex so we don't false-match on
    // unrelated text.
    expect(result).not.toMatch(/["']0 1px 3px rgba\(0,0,0,0\.05\)["']/);
  });

  test('falls back to existing JSX value when no defaultValue is provided', () => {
    // Backwards-compat: callers (or future call sites) that don't pass a
    // defaultValue still get the pre-modal behavior of capturing the inline
    // literal as the prop's default.
    const code = `export default function Card() {
  return (
    <div data-id="node-1" style={{ backgroundColor: '#abcdef' }}>Hello</div>
  );
}`;
    const result = createVariableInCode(code, 'node-1', 'backgroundColor', 'bgColor');
    expect(result).toContain('backgroundColor: bgColor');
    expect(result).toMatch(/bgColor\s*=\s*["']#abcdef["']/);
  });

  test('updates the function-signature default when the variable already exists (re-create flow)', () => {
    // The user picks a color preset on an already-bound variable property —
    // the new value (var(--color-brand)) must land in the function-signature
    // default. Previously this path was a no-op because createVariableInCode
    // bailed when it saw the existing Identifier in JSX.
    const code = `export default function Card({ color = 'red' }) {
  return (
    <p data-id="text" style={{ color: color }}>Hello</p>
  );
}`;
    const result = createVariableInCode(
      code, 'text', 'color', 'color', 'var(--color-brand)',
    );

    // JSX still references the variable Identifier (no change there)
    expect(result).toContain('color: color');
    // Function signature default is replaced — and the OLD default is gone
    // (no duplicate entry causing "Identifier already declared")
    expect(result).toMatch(/color\s*=\s*["']var\(--color-brand\)["']/);
    expect(result).not.toMatch(/color\s*=\s*['"]red['"]/);
  });

  test('replacing an existing variable default does not duplicate the destructured prop', () => {
    // Regression for `addPropToParams` blindly appending — that produced
    // `({ color = 'red', color = 'newval' })` which is invalid JS.
    const code = `export default function Card({ color = 'red', other = '5px' }) {
  return <p data-id="t" style={{ color: color }}>Hi</p>;
}`;
    const result = createVariableInCode(code, 't', 'color', 'color', '#abcdef');
    // Only ONE color destructure remains
    const matches = result.match(/\bcolor\s*=\s*['"][^'"]*['"]/g) || [];
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatch(/['"]#abcdef['"]/);
    // Other props left intact
    expect(result).toMatch(/other\s*=\s*['"]5px['"]/);
  });

  test('clearLonghands works even when the shorthand property is absent (atom collapses on bind)', () => {
    // The user might never have set `border` directly — only the longhands.
    // The atom can still create a variable by passing the shorthand value as
    // the default. We add `border: cardBorder` and drop the longhands.
    const code = `export default function Card() {
  return (
    <div data-id="node-1" style={{
      borderTopWidth: '2px', borderTopStyle: 'dashed', borderTopColor: 'blue',
      padding: '5px'
    }}>Hello</div>
  );
}`;
    const result = createVariableInCode(
      code, 'node-1', 'border', 'cardBorder', '2px dashed blue', BORDER_LONGHANDS,
    );

    expect(result).toContain('border: cardBorder');
    expect(result).not.toMatch(/borderTopWidth/);
    expect(result).not.toMatch(/borderTopStyle/);
    expect(result).not.toMatch(/borderTopColor/);
    expect(result).toMatch(/padding:\s*['"]5px['"]/);
    expect(result).toMatch(/cardBorder\s*=\s*["']2px dashed blue["']/);
  });
});

// ─── removeVariableInCode ───────────────────────────────────────────────────

describe('removeVariableInCode', () => {
  test('unbind (default) restores inline value but KEEPS the prop in the signature', () => {
    // The controls-panel × unbinds this node only; the prop stays so the variable persists in the
    // variable modal / for re-binding on other nodes. Full delete is `deleteProp=true` (modal).
    const originalCode = `export default function Card() {
  return (
    <div data-id="node-1" style={{ backgroundColor: '#1a1a2e' }}>Hello</div>
  );
}`;
    const withVariable = createVariableInCode(originalCode, 'node-1', 'backgroundColor', 'bgColor');
    expect(withVariable).toContain('backgroundColor: bgColor');

    const restored = removeVariableInCode(withVariable, 'node-1', 'backgroundColor', 'bgColor', '#1a1a2e');
    // The identifier is replaced back with a string literal on the node.
    expect(restored).toContain('#1a1a2e');
    // The prop is KEPT (default behavior — no deleteProp).
    expect(restored).toMatch(/bgColor\s*=\s*["']#1a1a2e["']/);
  });

  test('× pill remove (empty defaultValue) INJECTS the variable param default, not an empty value', () => {
    // The × pill passes defaultValue='' — removing must keep the styling by
    // falling back to the variable's own param default (e.g. joijoijoi = '#1E3C1B').
    const code = `export default function LayoutClient({ children, joijoijoi = "#1E3C1B" }) {
  return (
    <div data-id="node-1" style={{ backgroundColor: joijoijoi }}>x</div>
  );
}`;
    const out = removeVariableInCode(code, 'node-1', 'backgroundColor', 'joijoijoi', '');
    expect(out).toMatch(/backgroundColor: ["']#1E3C1B["']/);
    expect(out).not.toContain('backgroundColor: joijoijoi');
    // prop kept (controls-panel ×, not a full delete)
    expect(out).toMatch(/joijoijoi\s*=\s*["']#1E3C1B["']/);
  });

  test('empty defaultValue + NO param default → clears the property (old behavior preserved)', () => {
    const code = `export default function C({ x }) {
  return <div data-id="node-1" style={{ backgroundColor: x }}>x</div>;
}`;
    const out = removeVariableInCode(code, 'node-1', 'backgroundColor', 'x', '');
    expect(out).toMatch(/backgroundColor: ["']["']/);
  });

  test('deleteProp=true (variable modal) restores inline value AND removes the prop', () => {
    const code = `export default function Card({ bgColor = '#1a1a2e' }) {
  return (
    <div data-id="node-1" style={{ backgroundColor: bgColor }}>Hello</div>
  );
}`;
    const result = removeVariableInCode(code, 'node-1', 'backgroundColor', 'bgColor', '#ff0000', true);
    // Should use the provided default value as the literal.
    expect(result).toContain('#ff0000');
    // Prop removed from params (full delete).
    expect(result).not.toMatch(/bgColor\s*=\s*['"]#/);
  });

  test('preserves other props when deleting one (deleteProp=true)', () => {
    const code = `export default function Card({ bgColor = '#1a1a2e', fontSize = '16px' }) {
  return (
    <div data-id="node-1" style={{ backgroundColor: bgColor, fontSize: fontSize }}>Hello</div>
  );
}`;
    const result = removeVariableInCode(code, 'node-1', 'backgroundColor', 'bgColor', '#1a1a2e', true);
    // fontSize prop should still be there
    expect(result).toContain('fontSize');
    // bgColor should be removed from params
    expect(result).not.toMatch(/bgColor\s*=\s*['"]#1a1a2e['"]/);
  });

  test('returns generated code when node not found (prop still removed)', () => {
    const code = `export default function Card({ bgColor = '#1a1a2e' }) {
  return (
    <div data-id="node-1" style={{ backgroundColor: bgColor }}>Hello</div>
  );
}`;
    const result = removeVariableInCode(code, 'nonexistent', 'backgroundColor', 'bgColor', '#1a1a2e');
    // Should not crash; code still generates (prop removed from params, but style not changed)
    expect(result).toBeDefined();
  });

  test('handles arrow function component', () => {
    const code = `const Card = ({ bgColor = '#fff' }) => {
  return (
    <div data-id="node-1" style={{ backgroundColor: bgColor }}>Hello</div>
  );
}`;
    const result = removeVariableInCode(code, 'node-1', 'backgroundColor', 'bgColor', '#fff');
    expect(result).toContain('#fff');
  });

  test('OVERLAY border: unbind restores a literal in ::after, drops --X, KEEPS the prop', () => {
    const code = `export default function Card({ frameBorder = "2px solid #000" }) {
  return (
    <div data-id="node-1" style={{ position: 'absolute', "--frameBorder": frameBorder }}>
  <style>{\`
    [data-id="node-1"]::after {
  content: '';
  inset: 0;
  border: var(--frameBorder);
    }
  \`}</style>
    </div>
  );
}`;
    // Default (×): unbind only.
    const unbound = removeVariableInCode(code, 'node-1', 'border', 'frameBorder', '2px solid #000');
    expect(unbound).toContain('border: 2px solid #000');   // ::after restored to literal
    expect(unbound).not.toContain('var(--frameBorder)');   // var binding removed
    expect(unbound).not.toMatch(/["']--frameBorder["']\s*:/); // inline custom-prop dropped
    expect(unbound).toMatch(/frameBorder\s*=\s*"2px solid #000"/); // prop KEPT

    // Full delete (modal): also drops the prop.
    const deleted = removeVariableInCode(code, 'node-1', 'border', 'frameBorder', '2px solid #000', true);
    expect(deleted).not.toMatch(/frameBorder\s*=/);
  });
});

// ─── createTextVariableInCode / removeTextVariableInCode ────────────────────

describe('createTextVariableInCode', () => {
  test('replaces literal JSX text with {propName} and adds prop with captured default', () => {
    const code = `export default function Card() {
  return (
    <p data-id="title-node">Hello World</p>
  );
}`;
    const result = createTextVariableInCode(code, 'title-node', 'title');
    // Children replaced with a {title} expression
    expect(result).toMatch(/<p[^>]*>\s*\{\s*title\s*\}\s*<\/p>/);
    // Original literal text removed from JSX
    expect(result).not.toMatch(/<p[^>]*>\s*Hello World\s*<\/p>/);
    // Function signature carries the captured default
    expect(result).toMatch(/title\s*=\s*["']Hello World["']/);
  });

  test('uses caller-supplied defaultValue when provided (modal-edited path)', () => {
    const code = `export default function Card() {
  return <p data-id="title-node">Hello</p>;
}`;
    const result = createTextVariableInCode(code, 'title-node', 'title', 'Edited via modal');
    expect(result).toMatch(/title\s*=\s*["']Edited via modal["']/);
  });

  test('binds INSIDE a single wrapper span (font-family span around the whole text)', () => {
    // The text editor wraps the entire content in one styled span — the old
    // walk treated it as mixed content and silently no-oped (Variables modal
    // opened empty, user report 2026-07-31). The bind lands inside the span,
    // keeping its styling.
    const code = `export default function Card() {
  return (
    <p data-id="title-node" data-name="Text" style={{ fontSize: '45px' }}>
      <span style={{ fontFamily: 'Urbanist, sans-serif' }}>UI/ UX Design</span>
    </p>
  );
}`;
    const result = createTextVariableInCode(code, 'title-node', 'content');
    expect(result).not.toBe(code);
    expect(result).toMatch(/<span[^>]*>\s*\{\s*content\s*\}\s*<\/span>/);
    expect(result).toMatch(/fontFamily: 'Urbanist, sans-serif'/);
    expect(result).toMatch(/content\s*=\s*["']UI\/ UX Design["']/);
    // Round-trip: the parser must still surface the bound default as the
    // node's text so the canvas doesn't render an empty span.
    const nodes = parseJSXToNodes(result);
    const node = nodes.get('title-node')!;
    const flat = `${node.textContent ?? ''}`;
    expect(flat).toContain('UI/ UX Design');
  });

  test('bails on mixed content (child element present)', () => {
    const code = `export default function Card() {
  return (
    <p data-id="title-node">Hello <strong>World</strong></p>
  );
}`;
    const result = createTextVariableInCode(code, 'title-node', 'title');
    // Untouched — we don't try to variableize text that contains other JSX elements
    expect(result).toBe(code);
  });

  test('returns original code when node id not found', () => {
    const code = `export default function Card() {
  return <p data-id="other">Hi</p>;
}`;
    const result = createTextVariableInCode(code, 'missing', 'title');
    expect(result).toBe(code);
  });
});

describe('removeTextVariableInCode', () => {
  test('unbind (default): injects the SIGNATURE default text (× passes \'\') but KEEPS the prop', () => {
    const code = `export default function Card({ title = 'Hello' }) {
  return (
    <p data-id="title-node">{title}</p>
  );
}`;
    // The × pill passes '' for the default — must fall back to the prop's signature default, not empty.
    const result = removeTextVariableInCode(code, 'title-node', 'title', '');
    expect(result).toMatch(/<p[^>]*>\s*Hello\s*<\/p>/);     // NOT an empty <p></p>
    // Prop STILL declared — the variable stays in the modal for re-binding (× never deletes it).
    expect(result).toMatch(/title\s*=\s*['"]Hello['"]/);
  });

  test('deleteProp=true (modal delete): inlines AND drops the prop from signature', () => {
    const code = `export default function Card({ title = 'Hello' }) {
  return <p data-id="x">{title}</p>;
}`;
    const result = removeTextVariableInCode(code, 'x', 'title', 'Hello', true);
    expect(result).toMatch(/<p[^>]*>\s*Hello\s*<\/p>/);
    expect(result).not.toMatch(/title\s*=\s*['"]Hello['"]/);
  });

  test('uses the caller-supplied default text — not whatever was in the function signature', () => {
    // If the user changed the modal's default before clicking Remove, that
    // edited value is what should land in the JSX.
    const code = `export default function Card({ title = 'Hello' }) {
  return <p data-id="x">{title}</p>;
}`;
    const result = removeTextVariableInCode(code, 'x', 'title', 'Goodbye', true); // full delete
    expect(result).toMatch(/<p[^>]*>\s*Goodbye\s*<\/p>/);
    expect(result).not.toMatch(/Hello/);
  });

  test('full delete inlines a per-variant ternary fallback — no dangling identifier after the prop is dropped', () => {
    // A text variable detached on one variant leaves `{... ? 'lit' : content}`. A full delete must inline
    // the `content` fallback to the default literal, not leave it referencing the dropped prop.
    const code = `export default function Card({ initialVariant = 'default', content = 'Hello' }) {
  return <p data-id="x">{initialVariant === 'variant-2' ? 'Hi' : content}</p>;
}`;
    const result = removeTextVariableInCode(code, 'x', 'content', 'Hello', true);
    expect(result).not.toMatch(/\bcontent\b/);              // no dangling reference AND prop dropped
    expect(result).toMatch(/initialVariant === ['"]variant-2['"] \? ['"]Hi['"] : ['"]Hello['"]/); // branch kept, fallback inlined
    expect(parseJSX(result)).not.toBeNull();                // valid, parseable output
  });

  test('unbind keeps the prop even with a per-variant ternary (× pill never deletes)', () => {
    const code = `export default function Card({ initialVariant = 'default', content = 'Hello' }) {
  return <p data-id="x">{initialVariant === 'variant-2' ? 'Hi' : content}</p>;
}`;
    const result = removeTextVariableInCode(code, 'x', 'content', 'Hello'); // default unbind
    expect(result).toMatch(/content = 'Hello'/);            // prop KEPT
    expect(result).toMatch(/initialVariant === ['"]variant-2['"] \? ['"]Hi['"] : ['"]Hello['"]/);
    expect(parseJSX(result)).not.toBeNull();
  });
});

describe('addBarePropToFunctionInCode', () => {
  test('adds a bare destructured prop to an empty parameter list', () => {
    const code = `export default function Card() {
  return <div data-id="root" />;
}`;
    const result = addBarePropToFunctionInCode(code, 'myCursor');
    // No default — just a bare identifier inside the destructure.
    expect(result).toMatch(/function Card\(\{\s*myCursor\s*\}\)/);
  });

  test('appends to an existing destructure without disturbing prior props', () => {
    const code = `export default function Card({ title = 'Hi' }) {
  return <div data-id="root" />;
}`;
    const result = addBarePropToFunctionInCode(code, 'myCursor');
    expect(result).toMatch(/title = 'Hi'/);
    expect(result).toMatch(/myCursor/);
  });

  test('is idempotent when the prop is already declared', () => {
    const code = `export default function Card({ myCursor }) {
  return <div data-id="root" />;
}`;
    const result = addBarePropToFunctionInCode(code, 'myCursor');
    // Single occurrence in the signature — no duplicate identifier crash.
    const matches = result.match(/myCursor/g) ?? [];
    expect(matches.length).toBe(1);
  });

  test('supports a bare-identifier default for componentCursor', () => {
    const code = `export default function Card() {
  return <div data-id="root" />;
}`;
    const result = addBarePropToFunctionInCode(code, 'myCursor', 'DefaultCursor');
    // Default uses an Identifier (not a string literal) — so the master
    // preview can fall back to a real component, not the string
    // "DefaultCursor".
    expect(result).toMatch(/myCursor = DefaultCursor/);
    expect(result).not.toMatch(/myCursor = ['"]DefaultCursor['"]/);
  });

  test("'nullComponent' default emits `() => null` so an unset cursor renders nothing", () => {
    // Cursor variables use this: the prop defaults to a component that
    // renders nothing, so `withCursor(myCursor, …)` never receives
    // `undefined` (which would crash the preview with "Element type is
    // invalid") when the page instance hasn't picked a component.
    const code = `export default function Card() {
  return <div data-id="root" />;
}`;
    const result = addBarePropToFunctionInCode(code, 'myCursor', 'nullComponent');
    expect(result).toMatch(/myCursor = \(\) => null/);
  });

  test("'none' (default) emits a bare prop with no default", () => {
    const code = `export default function Card() {
  return <div data-id="root" />;
}`;
    const result = addBarePropToFunctionInCode(code, 'myCursor');
    expect(result).toMatch(/\{\s*myCursor\s*\}/);
    expect(result).not.toMatch(/myCursor\s*=/);
  });
});

describe('createLinkAttrVariableInCode', () => {
  const base = `export default function Card() {
  return <a data-id="lnk" href="/about" target="_blank">x</a>;
}`;

  test('string attr (href) → prop identifier + string default', () => {
    const r = createLinkAttrVariableInCode(base, 'lnk', {
      attrName: 'href', propName: 'linkHref', kind: 'string', defaultValue: '/about',
    });
    expect(r).toMatch(/href=\{linkHref\}/);
    expect(r).toMatch(/linkHref = ['"]\/about['"]/);
  });

  test('newTab → boolean ternary on target + boolean default', () => {
    const r = createLinkAttrVariableInCode(base, 'lnk', {
      attrName: 'target', propName: 'newTab', kind: 'newTab', defaultValue: 'true',
    });
    expect(r).toMatch(/target=\{newTab \? ['"]_blank['"] : undefined\}/);
    expect(r).toMatch(/newTab = true/);
  });

  test('injects the attribute when absent (smooth scroll)', () => {
    const r = createLinkAttrVariableInCode(base, 'lnk', {
      attrName: 'data-smooth-scroll', propName: 'smooth', kind: 'smooth', defaultValue: 'false',
    });
    expect(r).toMatch(/data-smooth-scroll=\{smooth \? ['"]true['"] : undefined\}/);
    expect(r).toMatch(/smooth = false/);
  });

  test('no-op when the data-id is not found', () => {
    const r = createLinkAttrVariableInCode(base, 'missing', {
      attrName: 'href', propName: 'x', kind: 'string', defaultValue: '/',
    });
    expect(r).toBe(base);
  });
});

describe('removeLinkAttrVariableInCode', () => {
  test('deleteProp:false (pill ×) → UNBINDS the node but KEEPS the param/variable', () => {
    const created = `export default function Card({ linkHref = '/about' }) {
  return <a data-id="lnk" href={linkHref}>x</a>;
}`;
    const r = removeLinkAttrVariableInCode(created, 'lnk', {
      attrName: 'href', propName: 'linkHref', kind: 'string', deleteProp: false,
    });
    expect(r).toMatch(/href=['"]\/about['"]/);   // attr unbound to its literal
    expect(r).toMatch(/href=\{?['"]?\/about/);   // node no longer references the var
    expect(r).toMatch(/linkHref\s*=\s*'\/about'/); // param KEPT (variable survives for other nodes)
  });

  test('string href → restores literal from prop default + drops prop', () => {
    const created = `export default function Card({ linkHref = '/about' }) {
  return <a data-id="lnk" href={linkHref}>x</a>;
}`;
    const r = removeLinkAttrVariableInCode(created, 'lnk', {
      attrName: 'href', propName: 'linkHref', kind: 'string',
    });
    expect(r).toMatch(/href=['"]\/about['"]/);
    expect(r).not.toMatch(/href=\{/);
    expect(r).not.toMatch(/linkHref/);
  });

  test('newTab true → restores target="_blank"', () => {
    const created = `export default function Card({ newTab = true }) {
  return <a data-id="lnk" target={newTab ? '_blank' : undefined}>x</a>;
}`;
    const r = removeLinkAttrVariableInCode(created, 'lnk', {
      attrName: 'target', propName: 'newTab', kind: 'newTab',
    });
    expect(r).toMatch(/target=['"]_blank['"]/);
    expect(r).not.toMatch(/newTab/);
  });

  test('smooth false → removes the attribute entirely', () => {
    const created = `export default function Card({ smooth = false }) {
  return <a data-id="lnk" data-smooth-scroll={smooth ? 'true' : undefined}>x</a>;
}`;
    const r = removeLinkAttrVariableInCode(created, 'lnk', {
      attrName: 'data-smooth-scroll', propName: 'smooth', kind: 'smooth',
    });
    expect(r).not.toMatch(/data-smooth-scroll/);
    expect(r).not.toMatch(/smooth/);
  });

  test('round-trip: create then remove returns to a clean literal', () => {
    const start = `export default function Card() {
  return <a data-id="lnk" href="/about">x</a>;
}`;
    const created = createLinkAttrVariableInCode(start, 'lnk', {
      attrName: 'href', propName: 'linkHref', kind: 'string', defaultValue: '/about',
    });
    expect(created).toMatch(/href=\{linkHref\}/);
    const removed = removeLinkAttrVariableInCode(created, 'lnk', {
      attrName: 'href', propName: 'linkHref', kind: 'string',
    });
    expect(removed).toMatch(/href=['"]\/about['"]/);
    expect(removed).not.toMatch(/linkHref/);
  });
});

describe('setBorderOverlayVariableForVariant — per-variant-only border variable', () => {
  const COMP = `'use client';
const fooVariants = { default: {}, 'variant-1': {} };
function C({ style, initialVariant = 'default' }) {
  return (
    <motion.div data-id="foo" variants={fooVariants} initial={initialVariant} animate={initialVariant} style={{
      position: 'absolute',
      width: '100px'
    }}>
      <div data-id="child" style={{ position: 'absolute' }}></div>
    </motion.div>
  );
}
export default C;
`;

  test('writes an inline ternary on --X + ::after var + adds the prop', () => {
    const out = setBorderOverlayVariableForVariant(COMP, 'foo', 'myBorder', 'variant-1', '5px solid #f00');
    expect(out).toContain('border: var(--myBorder)');
    expect(out).toMatch(/initialVariant === ["']variant-1["'] \? myBorder : ["']none["']/);
    expect(out).toMatch(/myBorder\s*=\s*["']5px solid #f00["']/);
  });

  test('parses to per-variant conditional binding (variant-1 has the var, default = none)', () => {
    const out = setBorderOverlayVariableForVariant(COMP, 'foo', 'myBorder', 'variant-1', '5px solid #f00');
    const n = parseJSXToNodes(out).get('foo')!;
    expect(n.conditionalStyles!['--myBorder']).toEqual({ 'variant-1': '5px solid #f00', default: 'none' });
    // The pill marker is mirrored onto BOTH the custom prop and the ::after-consumed `border`.
    expect(n.conditionalStyleVariables!['--myBorder']).toEqual({ 'variant-1': 'myBorder' });
    expect(n.conditionalStyleVariables!.border).toEqual({ 'variant-1': 'myBorder' });
    // No BASE binding — it's variant-scoped only.
    expect(n.styleVariables?.border).toBeUndefined();
  });

  test('remove (unbind) strips the conditional + ::after var, KEEPS the prop', () => {
    const created = setBorderOverlayVariableForVariant(COMP, 'foo', 'myBorder', 'variant-1', '5px solid #f00');
    const removed = removeVariableInCode(created, 'foo', 'border', 'myBorder', '5px solid #f00');
    expect(removed).not.toContain('var(--myBorder)');        // ::after var stripped
    expect(removed).not.toMatch(/["']--myBorder["']\s*:/);   // inline ternary dropped
    expect(removed).not.toContain('border: 5px solid #f00'); // NOT painted as a literal (variant-only)
    expect(removed).toMatch(/myBorder\s*=/);                 // prop KEPT (× keeps it)
  });
});

describe('setInlineVariableForVariant — per-variant-only variable for ANY (non-border) property', () => {
  // The variable lives on ONE variant. A style ternary with a variable is forbidden
  // (VARIABLE_TERNARY_BINDING) AND a variant OBJECT overrides an inline ternary anyway — so the generator
  // SPLITS the element into the engine's blessed conditionally-rendered pair (whole-value var on the target
  // variant, original kept for the rest). `foo` is nested (not the root) like the real Header logo.
  const COMP = `'use client';
const fooVariants = { default: {}, 'variant-1': {} };
function C({ style, initialVariant = 'default' }) {
  return (
    <div data-id="root">
      <motion.div data-id="foo" variants={fooVariants} initial={initialVariant} animate={initialVariant} style={{
        position: 'absolute',
        backgroundColor: '#97cffc'
      }}>x</motion.div>
    </div>
  );
}
export default C;
`;
  test('binds the var straight into the variant OBJECT (idiomatic), moves the const into the function, ONE element', () => {
    const out = setInlineVariableForVariant(COMP, 'foo', 'backgroundColor', 'variant-1', 'bgVar', '#97cffc', '#ff0000');
    expect(out).not.toContain('AnimatePresence');             // NO split
    expect(out).not.toContain('data-id="foo-base"');          // NO duplicate element
    expect(out).not.toMatch(/\? bgVar :/);                    // NO ternary
    expect(out).toMatch(/'variant-1':\s*\{\s*backgroundColor:\s*bgVar\s*\}/); // variable IN the variant object
    expect(out).toMatch(/function C[\s\S]*const fooVariants/); // const MOVED into the component
    expect(out).not.toMatch(/^const fooVariants/m);           // gone from module scope (can now see the prop)
    expect(out).toMatch(/bgVar\s*=\s*["']#ff0000["']/);       // prop added
  });
  test('parses: the variant-object variable resolves to the prop default + records motionVariantVariables', () => {
    const out = setInlineVariableForVariant(COMP, 'foo', 'backgroundColor', 'variant-1', 'bgVar', '#97cffc', '#ff0000');
    const n = parseJSXToNodes(out).get('foo')! as any;
    expect(n.motionVariants['variant-1'].backgroundColor).toBe('#ff0000'); // resolved to bgVar's default
    expect(n.motionVariantVariables['variant-1'].backgroundColor).toBe('bgVar'); // recorded for the panel
  });
  test('remove MERGES the split back to the base element (drops AnimatePresence), KEEPS the prop', () => {
    const created = setInlineVariableForVariant(COMP, 'foo', 'backgroundColor', 'variant-1', 'bgVar', '#97cffc', '#ff0000');
    const removed = removeVariableInCode(created, 'foo', 'backgroundColor', 'bgVar', '#97cffc');
    expect(removed).not.toContain('bgVar :');
    expect(removed).not.toContain('data-id="foo-base"');  // renamed back to foo
    expect(removed).not.toContain('AnimatePresence');     // wrappers removed
    expect(removed).toMatch(/data-id="foo"/);
    expect(removed).toMatch(/backgroundColor:\s*["']#97cffc["']/);
    expect(removed).toMatch(/bgVar\s*=/);                  // prop KEPT (deleteProp=false)
  });
});

describe('setComponentPropDefaultInCode — edit a variable default from the modal', () => {
  test('replaces an existing string default', () => {
    const code = `function C({ style, ponoinoin = "1px solid #000" }) { return <div data-id="x" style={{ border: ponoinoin }}></div>; }`;
    const out = setComponentPropDefaultInCode(code, 'ponoinoin', '8px solid #CC6868');
    expect(out).toMatch(/ponoinoin\s*=\s*["']8px solid #CC6868["']/);
    expect(out).not.toContain('1px solid #000');
  });
  test('adds a default to a bare prop', () => {
    const out = setComponentPropDefaultInCode(`function C({ style, foo }) { return <div data-id="x"></div>; }`, 'foo', '5px');
    expect(out).toMatch(/foo\s*=\s*["']5px["']/);
  });
  test('no-op when the prop is not in the signature', () => {
    const code = `function C({ style }) { return <div data-id="x"></div>; }`;
    expect(setComponentPropDefaultInCode(code, 'zzz', '5px')).toBe(code);
  });
});

describe('createConditionalVariableInCode — boolean visibility variables', () => {
  test('binds display via a ternary + boolean prop default', () => {
    const code = `export default function Card() {
  return <div data-id="n" style={{ display: 'none' }}></div>;
}`;
    const out = createConditionalVariableInCode(code, 'n', 'display', 'hidden', 'none', '', 'true');
    expect(out).toMatch(/display:\s*hidden\s*\?\s*['"]none['"]\s*:\s*['"]['"]/);
    expect(out).toMatch(/hidden\s*=\s*true\b/); // BooleanLiteral default, unquoted
  });

  test('flexWrap wrap/nowrap branches', () => {
    const code = `export default function Card() {
  return <div data-id="n" style={{ display: 'flex', flexWrap: 'wrap' }}></div>;
}`;
    const out = createConditionalVariableInCode(code, 'n', 'flexWrap', 'wrapped', 'wrap', 'nowrap', 'true');
    expect(out).toMatch(/flexWrap:\s*wrapped\s*\?\s*['"]wrap['"]\s*:\s*['"]nowrap['"]/);
    expect(out).toMatch(/wrapped\s*=\s*true\b/);
  });

  test('round-trips: parser reads the ternary back as a styleVariable binding', () => {
    const code = `export default function Card() {
  return <div data-id="n" style={{ display: 'none' }}></div>;
}`;
    const out = createConditionalVariableInCode(code, 'n', 'display', 'hidden', 'none', '', 'true');
    const nodes = parseJSXToNodes(out);
    expect(nodes.get('n')?.styleVariables?.display).toBe('hidden');
  });

  test('removeVariableInCode (unbind) inlines the ternary to the default branch + keeps prop', () => {
    const code = `export default function Card({ hidden = true }) {
  return <div data-id="n" style={{ display: hidden ? 'none' : '' }}></div>;
}`;
    const out = removeVariableInCode(code, 'n', 'display', 'hidden', 'none');
    expect(out).toMatch(/display:\s*['"]none['"]/);
    expect(out).not.toContain('hidden ?');
    expect(out).toMatch(/hidden\s*=\s*true/);
  });

  test('deleteComponentVariableInCode resolves the ternary by the boolean default + drops prop', () => {
    const code = `export default function Card({ hidden = false }) {
  return <div data-id="n" style={{ display: hidden ? 'none' : '' }}></div>;
}`;
    const out = deleteComponentVariableInCode(code, 'hidden');
    expect(out).not.toContain('hidden');
    expect(out).not.toContain('?');
  });
});

describe('hoistMapBindingsToProps — CMS component (Mechanism B auto-wire)', () => {
  const COMP = `'use client';
import React from 'react';
import { motion } from 'framer-motion';
function TeamCard({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return <motion.div data-id="card-root" key={idx} {...rest} style={{ ...style }}>
    <motion.div data-id="photo" style={{ backgroundImage: \`url(\${item.photo})\` }} />
    <motion.p data-id="name">{item.name}</motion.p>
    <motion.p data-id="role">{item.role}</motion.p>
  </motion.div>;
}
export default TeamCard;`;

  test('rewrites item.field → field, adds props before ...rest, relocates key', () => {
    const { code, fields, keyExpr } = hoistMapBindingsToProps(COMP, 'item');
    expect(fields).toEqual(['photo', 'name', 'role']);     // first-seen (depth-first) order
    expect(keyExpr).toBe('idx');                            // map key relocated off the root
    expect(parseJSX(code)).not.toBeNull();                  // still valid
    expect(code).not.toMatch(/item\./);                     // no stray item refs (would crash)
    expect(code).not.toMatch(/key=\{idx\}/);                // key removed from the component root
    expect(code).toMatch(/url\(\$\{photo\}\)/);             // style binding → prop ref
    expect(code).toMatch(/>\{name\}</);                     // text binding → prop ref
    expect(code).toMatch(/photo = (?:''|"")/);              // props added to signature (empty-string default)
    expect(code).toMatch(/name = (?:''|"")/);
    expect(code).toMatch(/role = (?:''|"")/);
    expect(code).toMatch(/\.\.\.rest/);                     // ...rest still last
  });

  // ── stagger-index hoist (`.map((item, index) =>` + `delay: index * 0.1`) ──
  test('hoists a bare stagger-index reference as a NUMBER prop (default 0)', () => {
    const comp = `function Card({ style, ...rest }: { style?: any; [key: string]: any }) {
  return <motion.div data-id="img" transition={{ duration: 0.75, delay: 0 + index * 0.1 }} style={{ backgroundImage: \`url(\${item.photo})\`, ...style }} />;
}`;
    const { code, fields, indexField } = hoistMapBindingsToProps(comp, 'item', {}, new Set(), 'index');
    expect(indexField).toBe('index');
    expect(fields).toEqual(['photo']);
    expect(code).toMatch(/index = 0/);                      // signature param, numeric default
    expect(code).toMatch(/delay: 0 \+ index \* 0\.1/);      // usage untouched (prop now in scope)
    expect(parseJSX(code)).not.toBeNull();
  });

  test('indexField is null when the subtree never references the index var', () => {
    const comp = `function Card({ style }: { style?: any }) { return <p data-id="x" style={{ ...style }}>{item.name}</p>; }`;
    const { code, indexField } = hoistMapBindingsToProps(comp, 'item', {}, new Set(), 'index');
    expect(indexField).toBeNull();
    expect(code).not.toMatch(/index = 0/);
  });

  test('index var is NOT hoisted from non-value positions (object key / member prop)', () => {
    const comp = `function Card({ style }: { style?: any }) { return <p data-id="x" style={{ index: '1', order: foo.index, ...style }}>{item.name}</p>; }`;
    const { indexField } = hoistMapBindingsToProps(comp, 'item', {}, new Set(), 'index');
    expect(indexField).toBeNull();
  });

  test('a hoisted item FIELD named like the index var wins (no double param)', () => {
    const comp = `function Card({ style }: { style?: any }) { return <p data-id="x" style={{ ...style }}>{item.index}</p>; }`;
    const { code, fields, indexField } = hoistMapBindingsToProps(comp, 'item', {}, new Set(), 'index');
    expect(fields).toEqual(['index']);
    expect(indexField).toBeNull();
    expect((code.match(/index = /g) ?? []).length).toBe(1);
  });

  test('no-op when the subtree has no item bindings or key', () => {
    const plain = `function C({ style }: { style?: any }) { return <div data-id="x" style={{ ...style }}>hi</div>; }`;
    const r = hoistMapBindingsToProps(plain, 'item');
    expect(r.fields).toEqual([]);
    expect(r.keyExpr).toBeNull();
    expect(r.code).toBe(plain);
  });

  test('item.a.b hoists only the top-level field a (preserves the deep access)', () => {
    const c = `function C({ style }: { style?: any }) { return <p data-id="x" style={{ ...style }}>{item.meta.label}</p>; }`;
    const { code, fields } = hoistMapBindingsToProps(c, 'item');
    expect(fields).toEqual(['meta']);
    expect(code).toMatch(/\{meta\.label\}/);
  });

  test('seeds prop defaults from the first item (no longer empty)', () => {
    const { code } = hoistMapBindingsToProps(
      COMP, 'item',
      { photo: "url(http://x/p.jpg)", name: 'Sarah', role: 'CEO' },
      new Set(['photo']),
    );
    expect(code).toMatch(/name = (?:'Sarah'|"Sarah")/);
    expect(code).toMatch(/role = (?:'CEO'|"CEO")/);
    expect(code).not.toMatch(/name = (?:''|"")/);            // not empty anymore
  });

  test('IMAGE field → WHOLE-VALUE convention: bare binding + url()-wrapped default (image picker)', () => {
    // A wrapped master binding (`url(${photo})`) reads as a URL-TEXT variable —
    // the instance panel shows a text field instead of the image picker (live
    // find 2026-07-08). Convert to the whole-value shape: bare
    // `backgroundImage: photo`, default wrapped to `url(...)`, and the CALLER
    // binds instances wrapped (`photo={\`url(\${item.photo})\`}`) — live still
    // renders, panel shows the picker (the AboutPoint pattern).
    const { code, wholeValueImageFields } = hoistMapBindingsToProps(
      COMP, 'item',
      { photo: 'http://x/p.jpg' },   // PLAIN-URL input — the hoist wraps the default
      new Set(['photo']),
    );
    expect(wholeValueImageFields).toEqual(['photo']);
    expect(code).toMatch(/backgroundImage:\s*photo\b/);              // collapsed to bare
    expect(code).not.toMatch(/backgroundImage:\s*`url\(\$\{photo\}\)`/);
    expect(code).toMatch(/photo = (?:'|")url\(http:\/\/x\/p\.jpg\)(?:'|")/); // wrapped default
    expect(parseJSX(code)).not.toBeNull();
  });

  test('IMAGE field used ALSO outside url() (e.g. <img src>) keeps the wrapped-template form', () => {
    const MIXED = `function C({ style }: { style?: any }) {
  return <div data-id="x" style={{ backgroundImage: \`url(\${item.photo})\`, ...style }}>
    <img data-id="y" src={item.photo} alt="" />
  </div>;
}`;
    const { code, wholeValueImageFields } = hoistMapBindingsToProps(
      MIXED, 'item', { photo: 'http://x/p.jpg' }, new Set(['photo']),
    );
    expect(wholeValueImageFields).toEqual([]);                        // NOT converted
    expect(code).toMatch(/backgroundImage:\s*`url\(\$\{photo\}\)`/); // wrapped form kept
    expect(code).toMatch(/src=\{photo\}/);                            // src stays a plain URL
    expect(code).toMatch(/photo = (?:'http:\/\/x\/p\.jpg'|"http:\/\/x\/p\.jpg")/); // plain default
  });

  test('hoists optional-chaining item?._slug (the data-cms-nav href) — no dangling item', () => {
    const c = "function C({ style }: { style?: any }) { return <a data-id=\"x\" href={`/p/${item?._slug ?? ''}`} style={{ ...style }}>x</a>; }";
    const { code, fields } = hoistMapBindingsToProps(c, 'item', { _slug: 'sarah' });
    expect(fields).toEqual(['_slug']);
    expect(code).not.toMatch(/item\?/);                        // optional item ref hoisted away
    expect(code).toMatch(/_slug \?\? ''/);                     // bare prop ref kept in the href
    expect(code).toMatch(/_slug = (?:'sarah'|"sarah")/);
  });
});

describe('bindTextNodeAsPageVarInCode — settable page text variable bind (no prop added)', () => {
  const CODE = `'use client';
import React from 'react';
export default function Page() {
  return <div data-id="root"><p data-id="t" data-name="Text">Hello world</p></div>;
}`;
  test('binds the text node to {content} and leaves the signature WITHOUT a prop', () => {
    const out = bindTextNodeAsPageVarInCode(CODE, 't', 'content', 'Hello world');
    expect(out).toContain('{content}');
    expect(out).not.toContain('Hello world</p>');
    // Unlike createTextVariableInCode, NO `{ content = … }` param is added — the
    // caller declares a @pageVariables/useState instead.
    expect(out).toMatch(/function Page\(\)\s*\{/);
    expect(out).not.toMatch(/function Page\(\s*\{/);
  });
  test('binds inside a SINGLE wrapper span; still no-op on interleaved mixed content', () => {
    // A lone wrapper span is the styled-whole-text shape — the bind now lands
    // INSIDE it (2026-07-31). Interleaved content (text + element) stays a
    // no-op: a single variable can't represent it.
    const single = `export default function Page() { return <div data-id="root"><p data-id="t"><span>Hi</span></p></div>; }`;
    expect(bindTextNodeAsPageVarInCode(single, 't', 'content')).toContain('<span>{content}</span>');
    const interleaved = `export default function Page() { return <div data-id="root"><p data-id="t">Hello <span>Hi</span></p></div>; }`;
    expect(bindTextNodeAsPageVarInCode(interleaved, 't', 'content')).toBe(interleaved);
  });
});
