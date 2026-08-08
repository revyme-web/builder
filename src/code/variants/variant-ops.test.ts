import { describe, test, expect, vi, beforeEach } from 'vitest';
import { parse as babelParse } from '@babel/parser';

// Mock modifyProjectFile so we can capture the transform function and test it in isolation.
// The real modifyProjectFile reads/writes from ProjectFS; we just want to run the transform.
let capturedTransform: ((code: string) => string) | null = null;
vi.mock('../project/modify-file', () => ({
  modifyProjectFile: (_filePath: string, transform: (code: string) => string) => {
    capturedTransform = transform;
    // Execute the transform with a placeholder code so internal logic runs
    // (but callers can also run it manually with custom code)
    return null;
  },
}));

import { addVariant, removeVariant, updateVariantPosition, renameVariant } from './variant-ops';

beforeEach(() => {
  capturedTransform = null;
});

// ─── addVariant (via captured transform) ────────────────────────────────────

describe('addVariant', () => {
  const baseCode = `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
];

const navVariants = {
  default: { opacity: 1, x: 0 },
};

export default function Nav() {
  return <motion.div variants={navVariants} />;
}`;

  test('adds variant config entry with provided position', () => {
    addVariant('test.tsx', 'hover', { x: 600, y: 0 }, 'Hover');
    expect(capturedTransform).not.toBeNull();

    const result = capturedTransform!(baseCode);
    // New variant should appear in variantConfig
    expect(result).toContain("name: 'hover'");
    expect(result).toContain("label: 'Hover'");
    expect(result).toContain('x: 600');
  });

  // PAINT-ONLY object. The sparse model is about paint: an entry-less variant
  // renders default's value via animate={['default', variant]}, so seeding one
  // in would only produce a spurious "overridden" pill. (The shared `baseCode`
  // fixture states `x: 0`, a TRANSFORM — those are seeded on purpose, see below.)
  const paintOnlyCode = `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
];

const navVariants = {
  default: { opacity: 1, backgroundColor: '#fff' },
};

export default function Nav() {
  return <motion.div variants={navVariants} />;
}`;

  test('does NOT seed a variant key when there is no source override (sparse model)', () => {
    addVariant('test.tsx', 'hover', { x: 600, y: 0 }); // no sourceVariant
    const result = capturedTransform!(paintOnlyCode);

    // Sparse-entry model (design-tool parity): with no source override the new variant
    // inherits the default via animate={['default', variant]}, so NO entry is
    // seeded into navVariants — copying a default-equal value in would show the
    // spurious purple "overridden" pill (the logo-dots bug). It IS still added to
    // variantConfig.
    expect(result).not.toContain("'hover':");
    expect(result).toContain("name: 'hover'");
  });

  // The counterpart: motion HOLDS an animated transform when it switches to a
  // variant with no entry, so the sparse model would leave the element stuck
  // mid-state — a burger frozen as an X on every newly added variant (user
  // report 2026-08-01). Transform objects therefore always get an entry.
  test('DOES seed a transform entry (motion holds transforms across a variant switch)', () => {
    addVariant('test.tsx', 'hover', { x: 600, y: 0 }); // no sourceVariant
    const result = capturedTransform!(baseCode);       // default: { opacity: 1, x: 0 }
    expect(result).toContain("'hover':");
    expect(result).toMatch(/'hover':\s*\{[^}]*x:\s*0/);
  });

  test('seeds the transform value the variant ALREADY renders, not a blind neutral', () => {
    // default states rotate: 45 — an entry-less variant renders 45 today, so the
    // seed must be 45. Writing the neutral 0 would silently change the design.
    const rotated = baseCode.replace('default: { opacity: 1, x: 0 }', 'default: { opacity: 1, rotate: 45 }');
    addVariant('test.tsx', 'hover', { x: 600, y: 0 });
    const result = capturedTransform!(rotated);
    expect(result).toMatch(/'hover':\s*\{[^}]*rotate:\s*45/);
  });

  test('leaves a paint-only object sparse even when another object has transforms', () => {
    const mixed = paintOnlyCode.replace(
      'export default function Nav()',
      'const burgerVariants = {\n  default: { rotate: 0 },\n};\n\nexport default function Nav()');
    addVariant('test.tsx', 'hover', { x: 600, y: 0 });
    const result = capturedTransform!(mixed);
    // Slice each object's OWN body — a lazy regex from `const navVariants = {`
    // happily runs past its closing brace into the next object's entry.
    const bodyOf = (name: string) =>
      result.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\};`))![1];
    expect(bodyOf('burgerVariants')).toContain("'hover':");   // transform → seeded
    expect(bodyOf('navVariants')).not.toContain("'hover':");  // paint → stays sparse
  });

  test('auto-positions below last variant when no position provided', () => {
    addVariant('test.tsx', 'active');
    const result = capturedTransform!(baseCode);

    // Should have the variant
    expect(result).toContain("name: 'active'");
    // y should be 400 (maxBottom from default y=0 + 400) + 200 (gap) = 600
    expect(result).toContain('y: 600');
  });

  test('a name-colliding STALE variant-object entry is wiped + re-seeded from source (no duplicate)', () => {
    // `navVariants` has a `hover` entry but variantConfig does NOT — i.e. a STALE
    // orphan (the same shape as the Logo-Mark/Header `variant-6` collision). Adding
    // a `hover` variant wipes the stale entry first, then re-seeds from the source
    // (none here → sparse). Net: exactly ONE variantConfig entry, ZERO object entries.
    const codeWithHover = `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
];

const navVariants = {
  default: { opacity: 1 },
  hover: { opacity: 0.8 },
};

export default function Nav() { return <div />; }`;

    addVariant('test.tsx', 'hover', { x: 600, y: 0 });
    const result = capturedTransform!(codeWithHover);

    // Added to variantConfig exactly once.
    expect((result.match(/name: 'hover'/g) || []).length).toBe(1);
    // The stale `hover:` object entry is gone (no source → sparse, no duplicate).
    expect(result).not.toMatch(/\bhover:/);
  });

  test('copies the new key ONLY into objects the SOURCE variant overrides (sparse)', () => {
    // Source 'mobile' overrides boxVariants but NOT textVariants. The new variant
    // copies boxVariants' override and leaves textVariants sparse (it inherits the
    // default exactly like the source did — no spurious override).
    const multiCode = `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'mobile', label: 'Mobile', x: 500, y: 0 },
];

const boxVariants = {
  default: { scale: 1 },
  'mobile': { scale: 2 },
};

const textVariants = {
  default: { opacity: 1 },
};

export default function Box() { return <div />; }`;

    addVariant('test.tsx', 'variant-2', { x: 600, y: 0 }, 'New', 'mobile');
    const result = capturedTransform!(multiCode);

    // boxVariants HAS a 'mobile' override → copied to the new variant
    expect(result).toContain("'variant-2': { scale: 2 }");
    // textVariants has NO 'mobile' override → new variant inherits default, no entry
    expect(result).not.toContain("'variant-2': { opacity: 1 }");
  });

  test('uses label fallback to name', () => {
    addVariant('test.tsx', 'pressed', { x: 600, y: 0 });
    const result = capturedTransform!(baseCode);
    // When no label provided, label = name
    expect(result).toContain("label: 'pressed'");
  });

  test('cascades a MULTI-branch inline size ternary — new variant inherits the SOURCE branch value', () => {
    // The width is a per-variant inline ternary (mobile variants 390px; default falls to the 1280px
    // fallback). Creating a variant FROM a 390px variant must inherit 390px, not the fallback.
    // Regression: the continuation check used a 10-char window that cut the third `=` of `variant ===`,
    // so multi-branch chains broke after the first branch and the new variant silently got the fallback.
    const code = `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'mobile', label: 'Mobile', x: 500, y: 0 },
  { name: 'mobile-scrolled', label: 'Mobile S', x: 500, y: 560 },
];

function Comp() {
  return <motion.div data-id="root" style={{ width: variant === 'mobile' ? '390px' : variant === 'mobile-scrolled' ? '390px' : '1280px', height: '72px' }} />;
}
`;
    addVariant('test.tsx', 'variant-3', { x: 1000, y: 0 }, 'New', 'mobile-scrolled');
    const result = capturedTransform!(code);
    // exactly ONE new branch (no overlapping duplicate from the inner chain-starts), set to the source's 390px
    expect((result.match(/variant === 'variant-3'/g) || []).length).toBe(1);
    expect(result).toMatch(/variant === 'variant-3' \? '390px'/);
    // the original chain + fallback survive intact
    expect(result).toMatch(/variant === 'mobile-scrolled' \? '390px' : '1280px'/);
  });

  test('size ternary: creating from a FALLBACK variant adds NO branch (already the default value)', () => {
    const code = `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'mobile', label: 'Mobile', x: 500, y: 0 },
];

function Comp() {
  return <motion.div data-id="root" style={{ width: variant === 'mobile' ? '390px' : '1280px' }} />;
}
`;
    addVariant('test.tsx', 'variant-3', { x: 1000, y: 0 }, 'New', 'default'); // default resolves to the 1280px fallback
    const result = capturedTransform!(code);
    expect(result).not.toMatch(/variant === 'variant-3'/); // no redundant branch
  });

  test('cascades a DOUBLE-QUOTED per-variant CONTENT ternary — new variant inherits the SOURCE text', () => {
    // Per-variant TEXT overrides are emitted double-quoted: `{variant === "src" ?
    // "Blog" : "What we do"}`. The cascade originally matched single quotes only, so
    // these content overrides were skipped and a new variant created from a source
    // that renamed the text fell back to the primary ("Blog" → "What we do").
    const code = `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'src', label: 'Src', x: 500, y: 0 },
];

function Comp() {
  return <p data-id="t1">{variant === "src" ? "Blog" : "What we do"}</p>;
}
`;
    addVariant('test.tsx', 'variant-2', { x: 1000, y: 0 }, 'New', 'src');
    const result = capturedTransform!(code);
    // New variant inherits the SOURCE's "Blog", prepended with the chain's OWN
    // quote style (double, matching the content ternary).
    expect(result).toMatch(/variant === "variant-2" \? "Blog"/);
    // The original branch + fallback survive.
    expect(result).toContain('variant === "src" ? "Blog"');
    expect(result).toContain('"What we do"');
  });

  test('cascades a per-variant CONTENT ternary bound to a VARIABLE (bare identifier) — the standalone-replica bug', () => {
    // A text node bound to a component prop ONLY on a replica emits
    // `{variant === "variant-1" ? content : "Description"}` — the branch value
    // is the IDENTIFIER `content`, not a literal. The cascade matched only
    // numbers/quoted strings, so it skipped the whole chain and a variant made
    // from variant-1 lost the `content` binding (fell back to "Description").
    const code = `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'V1', x: 500, y: 0 },
];

function Comp() {
  return <p data-id="t1">{variant === "variant-1" ? content : "Description"}</p>;
}
`;
    addVariant('test.tsx', 'variant-2', { x: 1000, y: 0 }, 'New', 'variant-1');
    const result = capturedTransform!(code);
    // The new variant maps to the SAME variable, not the literal fallback.
    expect(result).toMatch(/variant === "variant-2" \? content/);
    expect(result).toContain('variant === "variant-1" ? content');
    expect(result).toContain('"Description"');
  });

  test('does NOT cascade a setVariant toggle (`… ? \'v1\' : variant`) — its fallback is the variant identifier', () => {
    const code = `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'V1', x: 500, y: 0 },
];

function Comp() {
  return <motion.div onHoverStart={() => setVariant(variant === 'default' ? 'variant-1' : variant)} />;
}
`;
    addVariant('test.tsx', 'variant-2', { x: 1000, y: 0 }, 'New', 'variant-1');
    const result = capturedTransform!(code);
    // The toggle is a connection handler, not a per-variant binding — left as-is.
    expect(result).toContain("setVariant(variant === 'default' ? 'variant-1' : variant)");
    expect(result).not.toMatch(/variant === 'variant-2' \? 'variant-1' : variant === 'default'/);
  });

  test('cascades an initialVariant-keyed ORDER ternary — new variant inherits the SOURCE order', () => {
    // Per-variant ORDER is written with the make-time `initialVariant === 'X'` form
    // (Styles tool / Layers reorder). A `variant`-only cascade skipped it, so a
    // variant created from variant-1 did NOT inherit its custom order. Creating
    // variant-2 FROM variant-1 must prepend `initialVariant === 'variant-2' ? <v1>`,
    // preserving the `initialVariant` form + single quotes.
    const code = `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'V1', x: 500, y: 0 },
];

function Comp() {
  return <div data-id="ld0" style={{ order: initialVariant === 'variant-1' ? 2 : 0 }} />;
}
`;
    addVariant('test.tsx', 'variant-2', { x: 1000, y: 0 }, 'New', 'variant-1');
    const result = capturedTransform!(code);
    expect(result).toContain("initialVariant === 'variant-2' ? 2 : initialVariant === 'variant-1' ? 2 : 0");
  });

  test('a NEW variant whose name COLLIDES with a STALE variant-object entry inherits the SOURCE, not the stale value', () => {
    // Repro: the Logo Mark carried `ld0Variants['variant-6']` (black) from a Header
    // make-component extraction. Creating a new variant-6 FROM variant-5 (no ld0
    // override → green default) wrongly inherited the stale black. The stale entry
    // must be WIPED first, so variant-6 inherits the default green (sparse).
    const code = `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-5', label: 'V5', x: 500, y: 0 },
];

const ld0Variants = {
  default: { backgroundColor: '#5acd88' },
  'variant-6': { backgroundColor: '#000000' },
};

function Comp() { return <div data-id="ld0" variants={ld0Variants} />; }`;
    addVariant('test.tsx', 'variant-6', { x: 1000, y: 0 }, 'New', 'variant-5');
    const result = capturedTransform!(code);
    // The stale 'variant-6' entry is gone → variant-6 inherits the default green.
    expect(result).not.toContain("'variant-6':");
  });

  test('a name-colliding NEW variant takes the SOURCE override, not the stale entry', () => {
    const code = `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-5', label: 'V5', x: 500, y: 0 },
];

const ld1Variants = {
  default: { backgroundColor: '#ffffff' },
  'variant-5': { backgroundColor: '#111111' },
  'variant-6': { backgroundColor: '#000000' },
};

function Comp() { return <div data-id="ld1" variants={ld1Variants} />; }`;
    addVariant('test.tsx', 'variant-6', { x: 1000, y: 0 }, 'New', 'variant-5');
    const result = capturedTransform!(code);
    expect(result).toContain("'variant-6': { backgroundColor: '#111111' }");
    expect(result).not.toContain("'variant-6': { backgroundColor: '#000000' }");
  });

  test('cascades AnimatePresence visibility from source variant (source visible)', () => {
    // Element visible ONLY on variant-1 via AnimatePresence + conditional.
    // Adding a new variant from variant-1 → new variant should ALSO be
    // visible. The generator picks whichever form (positive `===` chain
    // or negative `!==` chain) is shorter; what matters is that the new
    // variant ends up in the VISIBLE set, not excluded by a `!==` clause.
    const code = `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Tablet', x: 500, y: 0 },
];

function Comp() {
  return <motion.div data-id="root">
    <AnimatePresence mode="popLayout">{variant === 'variant-1' && <motion.div data-id="child-1" />}</AnimatePresence>
  </motion.div>;
}
`;
    addVariant('test.tsx', 'variant-2', { x: 1000, y: 0 }, 'Mobile', 'variant-1');
    const result = capturedTransform!(code);
    // Extract the AnimatePresence condition
    const condMatch = result.match(/<AnimatePresence[^>]*>\{([\s\S]*?)&&\s*<motion/);
    expect(condMatch).not.toBeNull();
    const cond = condMatch![1];
    // New variant must NOT be excluded by a `!== 'variant-2'` clause
    expect(cond).not.toMatch(/!==\s*['"]variant-2['"]/);
    // Existing variant-1 visibility preserved (NOT in any !== clause)
    expect(cond).not.toMatch(/!==\s*['"]variant-1['"]/);
  });

  test('cascades AnimatePresence visibility from source variant (source hidden)', () => {
    // Element HIDDEN on variant-1. Adding new variant from variant-1 →
    // new variant should also be hidden.
    const code = `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Tablet', x: 500, y: 0 },
];

function Comp() {
  return <motion.div data-id="root">
    <AnimatePresence mode="popLayout">{variant !== 'variant-1' && <motion.div data-id="child-1" />}</AnimatePresence>
  </motion.div>;
}
`;
    addVariant('test.tsx', 'variant-2', { x: 1000, y: 0 }, 'Mobile', 'variant-1');
    const result = capturedTransform!(code);
    // Variant-2 must be in the hidden set — either via `!== 'variant-2'`
    // or by being absent from a `=== 'X'` visible-only chain.
    const condMatch = result.match(/<AnimatePresence[^>]*>\{([\s\S]*?)&&\s*<motion/);
    expect(condMatch).not.toBeNull();
    const cond = condMatch![1];
    // variant-2 should be hidden — i.e., NOT in any `=== 'variant-2'` clause
    expect(cond).not.toMatch(/===\s*['"]variant-2['"]/);
  });

  test('cascades conditional style ternaries from source variant', () => {
    // `order: variant === 'variant-1' ? 1 : 0` — source variant-1 resolves to 1.
    // Adding variant-2 from variant-1 should give variant-2 the same order (1).
    const code = `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Tablet', x: 500, y: 0 },
];

function Comp() {
  return <motion.div data-id="root" style={{ display: 'flex', order: variant === 'variant-1' ? 1 : 0 }} />;
}
`;
    addVariant('test.tsx', 'variant-2', { x: 1000, y: 0 }, 'Mobile', 'variant-1');
    const result = capturedTransform!(code);
    // The new variant should have a branch with the source's resolved value (1)
    expect(result).toMatch(/variant\s*===\s*['"]variant-2['"]\s*\?\s*1/);
    // Original branches preserved
    expect(result).toMatch(/variant\s*===\s*['"]variant-1['"]\s*\?\s*1/);
  });

  test('skips ternary cascade when source resolves to fallback value', () => {
    // `order: variant === 'variant-1' ? 1 : 0` — for source='default', resolved
    // value is the fallback (0). No need to add a redundant `variant-2 ? 0`
    // branch; the fallback already covers it.
    const code = `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Tablet', x: 500, y: 0 },
];

function Comp() {
  return <motion.div data-id="root" style={{ order: variant === 'variant-1' ? 1 : 0 }} />;
}
`;
    addVariant('test.tsx', 'variant-2', { x: 1000, y: 0 }, 'Mobile', 'default');
    const result = capturedTransform!(code);
    // No new branch — fallback (0) covers variant-2 already
    expect(result).not.toMatch(/variant\s*===\s*['"]variant-2['"]\s*\?/);
    // Original variant-1 branch preserved
    expect(result).toMatch(/variant\s*===\s*['"]variant-1['"]\s*\?\s*1/);
  });
});

// ─── removeVariant (via captured transform) ──────────────────────────────────

describe('removeVariant', () => {
  const codeWithVariant = `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'hover', label: 'Hover', x: 600, y: 0 },
];

const navVariants = {
  default: { opacity: 1 },
  hover: { opacity: 0.5 },
};

export default function Nav() { return <div />; }`;

  test('removes variant from config and variant objects', () => {
    removeVariant('test.tsx', 'hover');
    expect(capturedTransform).not.toBeNull();

    const result = capturedTransform!(codeWithVariant);
    // hover should be removed from variantConfig
    expect(result).not.toContain("name: 'hover'");
    // hover key should be removed from navVariants
    expect(result).not.toMatch(/hover\s*:\s*\{\s*opacity:\s*0\.5\s*\}/);
    // default should still be there
    expect(result).toContain("name: 'default'");
    expect(result).toContain('opacity: 1');
  });

  test('does not remove primary variant', () => {
    removeVariant('test.tsx', 'default');
    const result = capturedTransform!(codeWithVariant);
    // Should return code unchanged since default is primary
    expect(result).toBe(codeWithVariant);
  });

  test('returns code unchanged for nonexistent variant', () => {
    removeVariant('test.tsx', 'nonexistent');
    const result = capturedTransform!(codeWithVariant);
    // The variant doesn't exist → filter removes nothing → but config is re-serialized
    // Actually, the code checks `configs.find(v => v.name === variantName)` and returns code if not found
    expect(result).toBe(codeWithVariant);
  });

  // Regression: deleting a HOVER interaction-state variant (the FAQ accordion
  // bug). The name has a hyphen so its variant-object key is QUOTED
  // ('default-hover'), the previous unquoted-only regex skipped it, and nothing
  // touched the mouseEnter/mouseLeave connections or the onHoverStart/onHoverEnd
  // handlers — leaving the whole `default-hover` machinery dangling.
  test('cleans up a hyphenated hover variant: config + quoted variant key + connections + handlers', () => {
    const faqCode = `const variantConfig = [
  { name: 'default', label: 'Closed', x: 0, y: 0, isPrimary: true },
  { name: 'open', label: 'Open', x: 880, y: 0 },
  { name: 'default-hover', label: 'Closed - Hover', x: 0, y: 120, interactionType: 'hover', parentVariant: 'default' }];

const iconWrapVariants = {
  default: { rotate: 0 },
  'open': { rotate: 45 },
  'default-hover': { rotate: 0 }
};

const connections = [
  { from: 'default', to: 'open', trigger: 'click', sourceNode: 'faq-root' },
  { from: 'open', to: 'default', trigger: 'click', sourceNode: 'faq-root' },
  { from: 'default', to: 'default-hover', trigger: 'mouseEnter' },
  { from: 'default-hover', to: 'default', trigger: 'mouseLeave' },
];

function FAQItem({ style, initialVariant = 'default' }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => {setVariant(initialVariant);}, [initialVariant]);
  return <motion.div
    onHoverEnd={() => setVariant(variant === 'default-hover' ? 'default' : variant)}
    onHoverStart={() => setVariant(variant === 'default' ? 'default-hover' : variant)}
    onTap={() => setVariant(variant === 'default' ? 'open' : variant === 'open' ? 'default' : variant)} data-id="faq-root" animate={['default', variant]}>
    <motion.div data-id="faq-icon" variants={iconWrapVariants} animate={['default', variant]} />
  </motion.div>;
}`;

    removeVariant('test.tsx', 'default-hover');
    const result = capturedTransform!(faqCode);

    // NOTHING should reference the deleted variant anywhere in the file.
    expect(result).not.toContain('default-hover');
    // …including the quoted variant-object key (the core regex bug).
    expect(result).not.toMatch(/'default-hover'\s*:/);
    // The hover connections are gone…
    expect(result).not.toMatch(/trigger:\s*'mouseEnter'/);
    expect(result).not.toMatch(/trigger:\s*'mouseLeave'/);
    // …and so are the now-orphaned hover handlers.
    expect(result).not.toContain('onHoverStart');
    expect(result).not.toContain('onHoverEnd');

    // The accordion's click toggle + its variants survive intact.
    expect(result).toContain('onTap');
    expect(result).toContain("from: 'default', to: 'open'");
    expect(result).toContain("'open': { rotate: 45 }");
    expect(result).toContain("name: 'open'");
    expect(result).toContain("name: 'default'");
  });
});

// ─── updateVariantPosition (via captured transform) ─────────────────────────

describe('updateVariantPosition', () => {
  const code = `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'hover', label: 'Hover', x: 600, y: 0 },
];

export default function Nav() { return <div />; }`;

  test('updates position of existing variant', () => {
    updateVariantPosition('test.tsx', 'hover', 800, 300);
    expect(capturedTransform).not.toBeNull();

    const result = capturedTransform!(code);
    expect(result).toContain('x: 800');
    expect(result).toContain('y: 300');
  });

  test('returns code unchanged for nonexistent variant', () => {
    updateVariantPosition('test.tsx', 'nonexistent', 100, 200);
    const result = capturedTransform!(code);
    expect(result).toBe(code);
  });

  test('rounds position values', () => {
    updateVariantPosition('test.tsx', 'hover', 123.7, 456.3);
    const result = capturedTransform!(code);
    // serializeVariantConfig uses Math.round
    expect(result).toContain('x: 124');
    expect(result).toContain('y: 456');
  });
});

// ─── replaceVariantConfigInCode (tested indirectly) ─────────────────────────

describe('replaceVariantConfigInCode (indirect)', () => {
  test('inserts config when none exists', () => {
    const codeNoConfig = `export default function Nav() { return <div />; }`;

    addVariant('test.tsx', 'hover', { x: 600, y: 0 });
    const result = capturedTransform!(codeNoConfig);

    // Should insert variantConfig before the export
    expect(result).toContain('const variantConfig');
    expect(result).toContain("name: 'default'");
    expect(result).toContain("name: 'hover'");
    // The export should still be there
    expect(result).toContain('export default function Nav');
  });
});

// ─── renameVariant (via captured transform) ────────────────────────────────

describe('renameVariant', () => {
  const codeWithVariant = `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Old Label', x: 600, y: 0 },
];

export default function Foo() { return <div />; }`;

  test('updates only the label, leaves name + position untouched', () => {
    renameVariant('test.tsx', 'variant-1', 'Hover');
    expect(capturedTransform).not.toBeNull();

    const result = capturedTransform!(codeWithVariant);
    expect(result).toContain("label: 'Hover'");
    // The internal `name` is the stable key — must not change.
    expect(result).toContain("name: 'variant-1'");
    // Position stays put.
    expect(result).toContain('x: 600');
  });

  test('no-op when label is unchanged', () => {
    renameVariant('test.tsx', 'variant-1', 'Old Label');
    const result = capturedTransform!(codeWithVariant);
    // Label stays the same — output should be byte-identical to input.
    expect(result).toBe(codeWithVariant);
  });

  test('no-op when label is whitespace-only', () => {
    renameVariant('test.tsx', 'variant-1', '   ');
    const result = capturedTransform!(codeWithVariant);
    expect(result).toBe(codeWithVariant);
  });

  test('trims whitespace from new label', () => {
    renameVariant('test.tsx', 'variant-1', '  Trimmed  ');
    const result = capturedTransform!(codeWithVariant);
    expect(result).toContain("label: 'Trimmed'");
    expect(result).not.toContain("label: '  Trimmed  '");
  });

  test('no-op when target variant does not exist', () => {
    renameVariant('test.tsx', 'ghost', 'Hover');
    const result = capturedTransform!(codeWithVariant);
    expect(result).toBe(codeWithVariant);
  });
});

// ─── addVariant with interaction param ──────────────────────────────────────

describe('addVariant interaction-state metadata', () => {
  const baseCode = `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
];

const cardVariants = {
  default: { color: '#000' },
};

export default function Card() { return <div />; }`;

  test('serializes interactionType + parentVariant in the variantConfig entry', () => {
    addVariant(
      'test.tsx',
      'default-hover',
      { x: 0, y: 600 },
      'Default - Hover',
      'default',
      { type: 'hover', parent: 'default' },
    );
    const result = capturedTransform!(baseCode);

    expect(result).toContain("name: 'default-hover'");
    expect(result).toContain("interactionType: 'hover'");
    expect(result).toContain("parentVariant: 'default'");
    // Source styles still copied into every variants object
    expect(result).toContain("'default-hover':");
    expect(result).toContain("color: '#000'");
  });

  test('omits interactionType + parentVariant when not provided', () => {
    addVariant('test.tsx', 'variant-1', { x: 600, y: 0 }, 'Variant 1');
    const result = capturedTransform!(baseCode);
    expect(result).toContain("name: 'variant-1'");
    expect(result).not.toContain('interactionType:');
    expect(result).not.toContain('parentVariant:');
  });
});

describe('removeVariant — conditional ternary cleanup', () => {
  const wrap = (jsx: string) => `const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'V1', x: 500, y: 0 },
  { name: 'variant-2', label: 'V2', x: 1000, y: 0 },
];

function Comp() {
  return ${jsx};
}`;

  test('collapses a single-branch style ternary to its fallback when the variant is deleted', () => {
    removeVariant('test.tsx', 'variant-1');
    const result = capturedTransform!(wrap(`<div data-id="ld0" style={{ order: initialVariant === 'variant-1' ? 2 : 0 }} />`));
    expect(result).toContain('order: 0');
    expect(result).not.toContain("=== 'variant-1'");
  });

  test('removes ONLY the deleted variant\'s branch from a multi-branch chain', () => {
    removeVariant('test.tsx', 'variant-1');
    const result = capturedTransform!(wrap(`<div data-id="r" style={{ width: variant === 'variant-1' ? '390px' : variant === 'variant-2' ? '500px' : '1280px' }} />`));
    expect(result).toContain("width: variant === 'variant-2' ? '500px' : '1280px'");
    expect(result).not.toContain("'variant-1'");
  });

  test('collapses a DOUBLE-quoted content/text ternary too', () => {
    removeVariant('test.tsx', 'variant-1');
    const result = capturedTransform!(wrap(`<p data-id="t">{variant === "variant-1" ? "Blog" : "What we do"}</p>`));
    expect(result).toContain('{"What we do"}');
    expect(result).not.toContain('"variant-1"');
  });

  test('leaves the setVariant toggle (identifier fallback) untouched — the connection teardown owns it', () => {
    removeVariant('test.tsx', 'variant-1');
    const result = capturedTransform!(wrap(`<div data-id="h" onTap={() => setVariant(variant === 'variant-1' ? 'mobile' : variant)} />`));
    // The walker requires a LITERAL fallback; this toggle's fallback is the `variant`
    // identifier, so the walker skips it (no connections present to clean it here).
    expect(result).toContain("setVariant(variant === 'variant-1' ? 'mobile' : variant)");
  });
});

// ─── removeVariant must never emit unparseable source ────────────────────────
//
// User report 2026-08-08: "I delete variant replica 2 and it deletes the whole
// component." Nothing was deleted — two brace-blind string transforms mis-cut
// the file, the parser returned an EMPTY node map, and the canvas rendered
// nothing. Both mis-cuts are reproduced below on the reported file's shape.

describe('removeVariant — brace-balanced teardown', () => {
  const parses = (code: string): boolean => {
    try {
      babelParse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
      return true;
    } catch {
      return false;
    }
  };

  // The accordion the user deleted `variant-1` ('open') from: a per-variant
  // TRANSITION (a nested object inside the variant entry) and a two-statement
  // click toggle — the two shapes the old `\{[^}]*\}` regexes could not cut.
  const accordionCode = `const variantConfig = [{
  name: 'default',
  label: 'close',
  x: 0,
  y: 0,
  isPrimary: true
}, {
  name: 'variant-1',
  label: 'open',
  x: 800,
  y: 0
}];
const frameVariants = {
  default: {
    backgroundColor: 'var(--color-bg)'
  },
  'variant-1': {
    transition: {
      duration: 0.5
    }
  }
};
const connections = [{
  from: 'default',
  to: 'variant-1',
  trigger: 'click'
}, {
  from: 'variant-1',
  to: 'default',
  trigger: 'click'
}];
function RoJiKu({ style, initialVariant = 'default', ...rest }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => {
    setVariant(initialVariant);
  }, [initialVariant]);
  return <motion.div onTap={() => {
      const _n = variant === 'default' ? 'variant-1' : variant === 'variant-1' ? 'default' : null;
      if (_n) setVariant(_n);
    }} layout={true} data-id="frame-1b" variants={frameVariants} {...rest} style={{
      height: variant === 'variant-1' ? 'min-content' : '41px'
    }} animate={['default', variant]} />;
}`;

  test('the deleted file still parses — nested variant entry + multi-statement handler', () => {
    expect(parses(accordionCode)).toBe(true);
    removeVariant('test.tsx', 'variant-1');
    const result = capturedTransform!(accordionCode);
    expect(parses(result)).toBe(true);
  });

  test('a nested-brace variant entry is consumed whole, leaving no stray brace', () => {
    removeVariant('test.tsx', 'variant-1');
    const result = capturedTransform!(accordionCode);
    expect(result).not.toContain("'variant-1'");
    expect(result).not.toContain('duration: 0.5');
    // The variants object keeps only `default` and closes cleanly.
    expect(result).toMatch(/const frameVariants = \{\s*default: \{\s*backgroundColor: 'var\(--color-bg\)'\s*\},?\s*\};/);
  });

  test('a multi-statement toggle handler is stripped whole — no orphaned brace on the tag', () => {
    removeVariant('test.tsx', 'variant-1');
    const result = capturedTransform!(accordionCode);
    expect(result).not.toContain('onTap');
    expect(result).not.toContain('setVariant(_n)');
    expect(result).not.toContain('<motion.div}');
    expect(result).toContain('<motion.div layout={true}');
  });

  test('refuses the write rather than landing a file that cannot be parsed', () => {
    // Force a corrupting outcome: an unbalanced variants object the balanced
    // remover has to bail on. The delete must be a no-op, never a blank canvas.
    const broken = accordionCode.replace("const frameVariants = {", "const frameVariants = { 'variant-1': { a: '}' ,");
    removeVariant('test.tsx', 'variant-1');
    const result = capturedTransform!(broken);
    expect(result).toBe(broken);
  });
});
