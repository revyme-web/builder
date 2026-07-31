/**
 * @vitest-environment jsdom
 *
 * Regression: when `enterComponentFile` is called with `from === to`
 * (e.g. double-clicking a node inside a master view that resolves to
 * the SAME file already active), it must short-circuit BEFORE any
 * side effects fire. The old version pushed a breadcrumb entry,
 * faded the canvas container to opacity:0, and registered a one-shot
 * onRenderComplete handler — but no new render fired (file unchanged),
 * so the user saw a blank canvas until the 1s safety timeout
 * unfaded it. Visually identical to "the master auto-exits after 2s".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enterComponentFile, extractComponentRootSize, computeFileEntryBounds, getPrimaryVariantId, collapseLibraryBreadcrumb } from './component-navigation';
import { projectFS } from '@/code/project/project-fs';
import { getDefaultStore } from 'jotai';
import { leftPanelAtom } from '@/code/stores/left-panel-store';

describe('enterComponentFile — same-file no-op short-circuit', () => {
  beforeEach(() => {
    // Seed projectFS with a minimal component file so the
    // hasComponentControls early-exit doesn't fire (no @controls).
    projectFS.writeFile('components/Same.tsx', `
function Same() { return <div data-id="root" />; }
export default Same;
`);
  });

  it('does NOT push a breadcrumb entry when from === to', () => {
    const setBreadcrumb = vi.fn();
    const setActiveFile = vi.fn();
    const setSelectedIds = vi.fn();
    const setUpdatingFromCanvas = vi.fn();
    const setInteractingViewport = vi.fn();

    enterComponentFile(
      {
        fromFilePath: 'components/Same.tsx',
        componentFilePath: 'components/Same.tsx',
        initialVariant: 'default',
      },
      {
        setActiveFile,
        setBreadcrumb,
        setSelectedIds,
        setUpdatingFromCanvas,
        setInteractingViewport,
        getNodes: () => new Map(),
      },
    );

    expect(setBreadcrumb).not.toHaveBeenCalled();
    expect(setActiveFile).not.toHaveBeenCalled();
    expect(setInteractingViewport).not.toHaveBeenCalled();
  });

  it('does NOT fade the canvas container when from === to', () => {
    const fakeContainer = document.createElement('div');
    fakeContainer.setAttribute('data-content-root', 'true');
    fakeContainer.style.overflow = 'hidden';
    fakeContainer.style.opacity = '1';
    document.body.appendChild(fakeContainer);

    enterComponentFile(
      {
        fromFilePath: 'components/Same.tsx',
        componentFilePath: 'components/Same.tsx',
        initialVariant: 'default',
      },
      {
        setActiveFile: () => {},
        setBreadcrumb: () => {},
        setSelectedIds: () => {},
        setUpdatingFromCanvas: () => {},
        setInteractingViewport: () => {},
        getNodes: () => new Map(),
      },
    );

    // Container opacity must stay at 1 — the no-op should not start a
    // fade that depends on a re-render to clear.
    expect(fakeContainer.style.opacity).toBe('1');
    fakeContainer.remove();
  });
});

describe('enterComponentFile — auto-switches the left panel to Layers', () => {
  const noopSetters = {
    setActiveFile: () => {},
    setBreadcrumb: () => {},
    setSelectedIds: () => {},
    setUpdatingFromCanvas: () => {},
    setInteractingViewport: () => {},
    getNodes: () => new Map(),
  };

  it('switches leftPanelAtom to "layers" when entering a master', () => {
    projectFS.writeFile('components/Target.tsx', `
function Target() { return <div data-id="root" style={{ width: '100px', height: '100px' }} />; }
export default Target;
`);
    getDefaultStore().set(leftPanelAtom, 'pages-layers'); // user on the Pages tab
    enterComponentFile(
      { fromFilePath: 'app/page.tsx', componentFilePath: 'components/Target.tsx', initialVariant: 'default' },
      noopSetters,
    );
    expect(getDefaultStore().get(leftPanelAtom)).toBe('layers');
  });

  it('does NOT switch on the same-file no-op (bails before)', () => {
    projectFS.writeFile('components/Same2.tsx', `
function Same2() { return <div data-id="root" />; }
export default Same2;
`);
    getDefaultStore().set(leftPanelAtom, 'library');
    enterComponentFile(
      { fromFilePath: 'components/Same2.tsx', componentFilePath: 'components/Same2.tsx', initialVariant: 'default' },
      noopSetters,
    );
    expect(getDefaultStore().get(leftPanelAtom)).toBe('library');
  });
});

describe('enterComponentFile — entryMode breadcrumb behaviour', () => {
  beforeEach(() => {
    // Seed two distinct masters so we can navigate between them.
    projectFS.writeFile('components/A.tsx', `
function A() { return <div data-id="root" />; }
export default A;
`);
    projectFS.writeFile('components/B.tsx', `
function B() { return <div data-id="root" />; }
export default B;
`);
    projectFS.writeFile('icons/X.tsx', `
function X() { return <div data-id="root" />; }
export default X;
`);
  });

  function captureBreadcrumb() {
    const setBreadcrumb = vi.fn();
    let cur: string[] = [];
    setBreadcrumb.mockImplementation((updater: any) => {
      cur = typeof updater === 'function' ? updater(cur) : updater;
    });
    return {
      setBreadcrumb,
      seed: (initial: string[]) => { cur = [...initial]; },
      get: () => cur,
    };
  }

  function fireEnter(opts: any, prevBreadcrumb: string[] = []) {
    const cap = captureBreadcrumb();
    cap.seed(prevBreadcrumb);
    enterComponentFile(opts, {
      setActiveFile: () => {},
      setBreadcrumb: cap.setBreadcrumb,
      setSelectedIds: () => {},
      setUpdatingFromCanvas: () => {},
      setInteractingViewport: () => {},
      getNodes: () => new Map(),
    });
    return cap.get();
  }

  // ─── Default (instance) mode — chain semantics preserved ────────────────
  it('instance mode: from a regular page seeds breadcrumb with that page', () => {
    expect(
      fireEnter({ fromFilePath: 'app/page.tsx', componentFilePath: 'components/A.tsx' }),
    ).toEqual(['app/page.tsx']);
  });

  it('instance mode: from a component appends to chain', () => {
    expect(
      fireEnter(
        { fromFilePath: 'components/A.tsx', componentFilePath: 'components/B.tsx' },
        ['app/page.tsx'],
      ),
    ).toEqual(['app/page.tsx', 'components/A.tsx']);
  });

  // ─── Library mode — collapse to original page ───────────────────────────
  it('library mode: from a regular page seeds breadcrumb with that page', () => {
    expect(
      fireEnter(
        { fromFilePath: 'app/page.tsx', componentFilePath: 'components/A.tsx', entryMode: 'library' },
      ),
    ).toEqual(['app/page.tsx']);
  });

  it('library mode: collapses chain to ONLY the original page (regression)', () => {
    // User flow: home → componentA → (library click) componentB
    // Old (instance) behaviour: ['app/page.tsx', 'components/A.tsx'].
    // New (library) behaviour:   ['app/page.tsx'] — drop the
    // intermediate so the gray page pill stays the original page.
    expect(
      fireEnter(
        { fromFilePath: 'components/A.tsx', componentFilePath: 'components/B.tsx', entryMode: 'library' },
        ['app/page.tsx', 'components/A.tsx'],
      ),
    ).toEqual(['app/page.tsx']);
  });

  it('library mode: handles deep chains the same — only prev[0] survives', () => {
    expect(
      fireEnter(
        { fromFilePath: 'components/D.tsx', componentFilePath: 'components/E.tsx', entryMode: 'library' },
        ['app/page.tsx', 'components/A.tsx', 'components/B.tsx', 'components/C.tsx'],
      ),
    ).toEqual(['app/page.tsx']);
  });

  it('library mode: from icon-set master keeps the original page', () => {
    // icons/ aren't `components/` paths but still count as masters —
    // the bug surfaced specifically here because the legacy "is component
    // file path?" test failed and reset the breadcrumb to the icon-set.
    expect(
      fireEnter(
        { fromFilePath: 'icons/X.tsx', componentFilePath: 'components/B.tsx', entryMode: 'library' },
        ['app/page.tsx'],
      ),
    ).toEqual(['app/page.tsx']);
  });

  it('library mode: empty prev seeds with fromFilePath (no original page yet)', () => {
    // Edge case: user opens directly into a master via deep-link / URL
    // and clicks Library. There's no "original page" to remember; the
    // current file is the only thing we have, so use it.
    expect(
      fireEnter(
        { fromFilePath: 'components/A.tsx', componentFilePath: 'components/B.tsx', entryMode: 'library' },
        [],
      ),
    ).toEqual(['components/A.tsx']);
  });

  // ─── Default omitted → instance mode ──────────────────────────────────
  it('omitting entryMode behaves identically to entryMode: "instance"', () => {
    const noMode = fireEnter(
      { fromFilePath: 'components/A.tsx', componentFilePath: 'components/B.tsx' },
      ['app/page.tsx'],
    );
    const explicit = fireEnter(
      { fromFilePath: 'components/A.tsx', componentFilePath: 'components/B.tsx', entryMode: 'instance' },
      ['app/page.tsx'],
    );
    expect(noMode).toEqual(explicit);
  });
});

describe('collapseLibraryBreadcrumb', () => {
  it('returns [fromFilePath] when prev is empty', () => {
    expect(collapseLibraryBreadcrumb([], 'app/page.tsx')).toEqual(['app/page.tsx']);
  });

  it('returns [prev[0]] when prev has one entry (drops fromFilePath in favour of original page)', () => {
    expect(collapseLibraryBreadcrumb(['app/page.tsx'], 'components/A.tsx')).toEqual(['app/page.tsx']);
  });

  it('collapses any chain length to just the original page', () => {
    expect(
      collapseLibraryBreadcrumb(
        ['app/home.tsx', 'components/A.tsx', 'components/B.tsx', 'components/C.tsx'],
        'components/D.tsx',
      ),
    ).toEqual(['app/home.tsx']);
  });

  it('is pure — does not mutate the input prev array', () => {
    const prev = ['app/page.tsx', 'components/A.tsx'];
    const frozen = Object.freeze([...prev]);
    expect(() => collapseLibraryBreadcrumb(frozen as string[], 'components/B.tsx')).not.toThrow();
    expect(prev).toEqual(['app/page.tsx', 'components/A.tsx']);
  });

  it('returns a NEW array (caller can mutate without affecting prev)', () => {
    const prev = ['app/page.tsx'];
    const out = collapseLibraryBreadcrumb(prev, 'components/A.tsx');
    expect(out).not.toBe(prev);
  });
});

describe('extractComponentRootSize', () => {
  it('reads width / height from the data-id="root" tag', () => {
    const code = `
function Card() {
  return <motion.div data-id="root" style={{ position: 'absolute', width: '320px', height: '180px', backgroundColor: 'red' }} />;
}
export default Card;
`;
    expect(extractComponentRootSize(code)).toEqual({ width: 320, height: 180 });
  });

  it('reads from a mangled data-id (real component-ops output)', () => {
    // Make Component emits a randomly-suffixed `frame-XXXX` data-id, NOT
    // `data-id="root"`. The regex must accept ANY data-id value.
    const code = `
function MyFrame() {
  return <motion.div data-id="frame-mox0ml2n-2" style={{ position: 'absolute', width: '1007px', height: '628px' }} />;
}
export default MyFrame;
`;
    expect(extractComponentRootSize(code)).toEqual({ width: 1007, height: 628 });
  });

  it('reads from a Variants object\'s default entry (preferred when present)', () => {
    // Real Make-Component output stores root size on the variants
    // object. Even if the JSX style had stale numbers, the variants
    // object's `default` entry is the source of truth.
    const code = `
const frameMox0ml2n2Variants = {
  default: {
    width: '1007px',
    height: '628px'
  }
};
function MyFrame() {
  return <motion.div data-id="frame-mox0ml2n-2" variants={frameMox0ml2n2Variants} style={{ width: '999px', height: '999px' }} />;
}
`;
    expect(extractComponentRootSize(code)).toEqual({ width: 1007, height: 628 });
  });

  it('reads a SPECIFIC variant\'s size when a variantName is given (quoted key)', () => {
    const code = `
const frameVariants = {
  default: { width: '1440px', height: '148px' },
  'variant-1': { width: '768px', height: '148px' },
  'variant-2': { width: '375px', height: '148px' },
};
function F() { return <motion.div data-id="frame-x" variants={frameVariants} />; }
`;
    expect(extractComponentRootSize(code, 'default')).toEqual({ width: 1440, height: 148 });
    expect(extractComponentRootSize(code, 'variant-1')).toEqual({ width: 768, height: 148 });
    expect(extractComponentRootSize(code, 'variant-2')).toEqual({ width: 375, height: 148 });
  });

  it('falls back to the default variant size when the requested one has no explicit size', () => {
    const code = `
const frameVariants = {
  default: { width: '1440px', height: '148px' },
  'variant-1': { opacity: '0.5' },
};
function F() { return <motion.div data-id="frame-x" variants={frameVariants} />; }
`;
    expect(extractComponentRootSize(code, 'variant-1')).toEqual({ width: 1440, height: 148 });
  });

  it('resolves a per-variant SIZE ternary in the inline style (not the variants object)', () => {
    // Variant size now lives in an inline ternary so it rides the layout FLIP.
    // The fit-to-component zoom must resolve the REQUESTED variant's branch —
    // a naive "first px" grab returned variant-1's size for every variant and
    // the tile sat offset-left.
    const code = `
const frameVariants = { default: {}, 'variant-1': {}, 'variant-2': {} };
function F({ initialVariant = 'default' }) {
  return <motion.div data-id="frame-x" variants={frameVariants} animate={initialVariant} style={{
    position: 'absolute',
    width: initialVariant === 'variant-1' ? '768px' : initialVariant === 'variant-2' ? '375px' : '1440px',
    height: initialVariant === 'variant-2' ? '462px' : '125px',
    backgroundColor: '#000',
  }} />;
}`;
    expect(extractComponentRootSize(code, 'default')).toEqual({ width: 1440, height: 125 });
    expect(extractComponentRootSize(code, 'variant-1')).toEqual({ width: 768, height: 125 });
    expect(extractComponentRootSize(code, 'variant-2')).toEqual({ width: 375, height: 462 });
  });

  it('resolves a ternary keyed on `variant` (post-connection) too', () => {
    const code = `
function F() {
  const [variant, setVariant] = useState(initialVariant);
  return <motion.div data-id="frame-x" animate={variant} style={{
    width: variant === 'variant-1' ? '768px' : '1440px',
    height: '125px',
  }} />;
}`;
    expect(extractComponentRootSize(code, 'variant-1')).toEqual({ width: 768, height: 125 });
    expect(extractComponentRootSize(code, 'default')).toEqual({ width: 1440, height: 125 });
  });

  it('handles a multi-line style block', () => {
    const code = `
<motion.div
  data-id="root"
  style={{
    position: 'absolute',
    width: '500px',
    height: '400px',
  }}
/>`;
    expect(extractComponentRootSize(code)).toEqual({ width: 500, height: 400 });
  });

  it('falls back to 800x600 when no element has both width and height', () => {
    expect(extractComponentRootSize('<div />')).toEqual({ width: 800, height: 600, estimated: true });
  });

  it('falls back when width/height are non-px (auto / %)', () => {
    const code = `<div data-id="root" style={{ width: 'auto', height: '100%' }} />`;
    expect(extractComponentRootSize(code)).toEqual({ width: 800, height: 600, estimated: true });
  });

  it('root with px width but auto height ESTIMATES from width — never a descendant box', () => {
    const code = `
<div data-id="root" style={{ width: '300px' }}>
  <span data-id="other" style={{ width: '50px', height: '50px' }} />
</div>
`;
    // The OLD fallthrough picked the 50×50 span — so entering a master whose
    // root is height:'auto' fitted a tiny descendant (a 70×70 avatar in the
    // wild) and slammed the camera to max zoom with the variant cut off.
    // A descendant's box can't speak for the tile: estimate 16:10 from the
    // root's width; the fit is slightly loose, never absurd.
    expect(extractComponentRootSize(code)).toEqual({ width: 300, height: 188, estimated: true });
  });

  it('root with no px dimensions at all falls back — not to a random child', () => {
    const code = `
<div data-id="root" style={{ width: '100%' }}>
  <span data-id="other" style={{ width: '50px', height: '50px' }} />
</div>
`;
    expect(extractComponentRootSize(code)).toEqual({ width: 800, height: 600, estimated: true });
  });
});

describe('computeFileEntryBounds', () => {
  beforeEach(() => {
    // Wipe any leftover state from previous suites so probes don't
    // pick up stale files.
    for (const f of projectFS.listFiles()) projectFS.deleteFile(f);
  });

  it('returns null for files that don\'t exist', () => {
    expect(computeFileEntryBounds('app/missing.tsx')).toBeNull();
  });

  it('reads an icon-set master\'s union bounds across every variant', () => {
    projectFS.writeFile('icons/Foo.tsx', `
/** @iconSet */
const iconConfig = [
  { name: 'icon-1', label: 'A', x: 0, y: 0, width: 240, height: 240, isPrimary: true },
  { name: 'icon-2', label: 'B', x: 280, y: 0, width: 240, height: 240 },
];
export default function Foo() { return null; }
`);
    expect(computeFileEntryBounds('icons/Foo.tsx')).toEqual({
      left: 0, top: 0, width: 520, height: 240,
    });
  });

  it('returns just the focused variant for an icon-set master when focusNodeId is given', () => {
    projectFS.writeFile('icons/Bar.tsx', `
/** @iconSet */
const iconConfig = [
  { name: 'icon-1', label: 'A', x: 0, y: 0, width: 100, height: 100, isPrimary: true },
  { name: 'icon-2', label: 'B', x: 200, y: 50, width: 80, height: 80 },
];
export default function Bar() { return null; }
`);
    expect(computeFileEntryBounds('icons/Bar.tsx', 'icon-2')).toEqual({
      left: 200, top: 50, width: 80, height: 80,
    });
  });

  it('centers on the PRIMARY variant (not the union) when no focusVariantName is given', () => {
    projectFS.writeFile('components/Card.tsx', `
const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Hover', x: 500, y: 0 },
];
export default function Card() {
  return <motion.div data-id="root" style={{ width: '320px', height: '200px' }} />;
}
`);
    // Entering a component lands on ONE variant viewport, never the union
    // (side-by-side variants span thousands of px → way-out zoom). With no
    // focus given, that's the isPrimary entry — `default` at (0,0), 320×200.
    expect(computeFileEntryBounds('components/Card.tsx')).toEqual({
      left: 0, top: 0, width: 320, height: 200,
    });
  });

  it('returns just the focused variant for a component master when focusVariantName is given', () => {
    projectFS.writeFile('components/Card.tsx', `
const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'hover', label: 'Hover', x: 500, y: 0 },
  { name: 'pressed', label: 'Pressed', x: 1000, y: 0 },
];
export default function Card() {
  return <motion.div data-id="root" style={{ width: '320px', height: '200px' }} />;
}
`);
    // focusVariantName is the third positional arg.
    expect(computeFileEntryBounds('components/Card.tsx', undefined, 'hover')).toEqual({
      left: 500, top: 0, width: 320, height: 200,
    });
  });

  it('auto-height master root → estimated bounds from root width, never a descendant box', () => {
    // The order-carousel Testimonial shape: root width 1280px / height 'auto'
    // (content-driven), deep 70×70 avatar descendants. The old scan returned
    // the avatar's box → entering the master fitted a 70px rect and the
    // camera slammed to max zoom with the variant cut off. Now: width from
    // the root, 16:10 estimated height, `estimated` flag so the entry flow
    // keeps the opacity dip and the post-render pass tightens on the real
    // rendered rect.
    projectFS.writeFile('components/Testimonial.tsx', `
const variantConfig = [
  { name: 'default', label: 'Default', x: 100, y: 50, isPrimary: true },
  { name: 'variant-2', label: 'Slide 2', x: 1480, y: 50 },
];
export default function Testimonial() {
  return (
    <motion.div data-id="tst-root" style={{ width: '1280px', height: 'auto', position: 'relative' }}>
      <motion.img data-id="tst-avatar-1" style={{ width: '70px', height: '70px', position: 'relative' }} />
    </motion.div>
  );
}
`);
    expect(computeFileEntryBounds('components/Testimonial.tsx', undefined, 'variant-2')).toEqual({
      left: 1480, top: 50, width: 1280, height: 800, estimated: true,
    });
  });

  it('sizes the box to the focused variant\'s OWN width/height (no left offset)', () => {
    projectFS.writeFile('components/Hdr.tsx', `
const variantConfig = [
  { name: 'default', label: 'Desktop', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Tablet', x: 1480, y: 0 },
];
const hdrVariants = {
  default: { width: '1440px', height: '148px' },
  'variant-1': { width: '768px', height: '148px' },
};
export default function Hdr() {
  return <motion.div data-id="root" variants={hdrVariants} style={{ width: '1440px', height: '148px' }} />;
}
`);
    // Focusing variant-1 must use 768 (its own width), NOT 1440 — so the box
    // is [1480..2248] and centers on the tile, not [1480..2920] (offset left).
    expect(computeFileEntryBounds('components/Hdr.tsx', undefined, 'variant-1')).toEqual({
      left: 1480, top: 0, width: 768, height: 148,
    });
  });

  it('falls back to the PRIMARY variant when focusVariantName matches no variant', () => {
    projectFS.writeFile('components/Card.tsx', `
const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'hover', label: 'Hover', x: 500, y: 0 },
];
export default function Card() {
  return <motion.div data-id="root" style={{ width: '320px', height: '200px' }} />;
}
`);
    // Stale / unmatched variant name (e.g. an instance pointing at a
    // viewport-keyed name) → land on the primary variant, NOT the union.
    expect(computeFileEntryBounds('components/Card.tsx', undefined, 'never-existed')).toEqual({
      left: 0, top: 0, width: 320, height: 200,
    });
  });

  it('reads a page\'s viewport bounds from the @canvas block', () => {
    projectFS.writeFile('app/page.tsx', `
/** @canvas {
  "viewports": [
    { "id": "desktop", "label": "Desktop", "width": 1440, "height": 900, "isPrimary": true, "order": 0 },
    { "id": "tablet", "label": "Tablet", "width": 768, "height": 1024, "isPrimary": false, "order": 1 }
  ],
  "positions": {
    "desktop": { "x": 0, "y": 0 },
    "tablet": { "x": 1500, "y": 0 }
  }
} */
export default function Page() { return null; }
`);
    expect(computeFileEntryBounds('app/page.tsx')).toEqual({
      left: 0, top: 0, width: 1500 + 768, height: 1024,
    });
  });

  it('returns null for a page with no @canvas block', () => {
    projectFS.writeFile('app/bare.tsx', `export default function Bare() { return null; }`);
    expect(computeFileEntryBounds('app/bare.tsx')).toBeNull();
  });
});

describe('getPrimaryVariantId', () => {
  beforeEach(() => {
    for (const f of projectFS.listFiles()) projectFS.deleteFile(f);
  });

  it('returns the isPrimary entry for an icon-set file', () => {
    // `addIconToSet` always writes the primary at index 0 (since
    // primary === "first entry"). The parser also auto-flags index 0
    // as primary when isPrimary is missing, so isPrimary always
    // converges on entry 0 in practice. Test mirrors that real shape.
    projectFS.writeFile('icons/X.tsx', `
/** @iconSet */
const iconConfig = [
  { name: 'icon-1', label: 'A', x: 0, y: 0, width: 240, height: 240, isPrimary: true },
  { name: 'icon-2', label: 'B', x: 280, y: 0, width: 240, height: 240 },
  { name: 'icon-3', label: 'C', x: 560, y: 0, width: 240, height: 240 },
];
export default function X() { return null; }
`);
    expect(getPrimaryVariantId('icons/X.tsx')).toBe('icon-1');
  });

  it('falls back to first entry when no isPrimary flag is set (legacy files)', () => {
    // Pre-isPrimary template wrote configs without the flag. Library
    // navigation must still pick *something*, so the first entry wins.
    projectFS.writeFile('icons/Legacy.tsx', `
/** @iconSet */
const iconConfig = [
  { name: 'icon-1', label: 'A', x: 0, y: 0, width: 240, height: 240 },
  { name: 'icon-2', label: 'B', x: 280, y: 0, width: 240, height: 240 },
];
export default function Legacy() { return null; }
`);
    expect(getPrimaryVariantId('icons/Legacy.tsx')).toBe('icon-1');
  });

  it('returns undefined for a missing file', () => {
    expect(getPrimaryVariantId('icons/missing.tsx')).toBeUndefined();
  });

  it('returns undefined for non-container-set files (page, component master)', () => {
    // enterComponentFile treats undefined as "fall back to all-content
    // fit", which is the correct behaviour for these kinds.
    projectFS.writeFile('app/page.tsx', `export default function P() { return null; }`);
    projectFS.writeFile('components/C.tsx', `
function C() { return <div data-id="root" />; }
export default C;
`);
    expect(getPrimaryVariantId('app/page.tsx')).toBeUndefined();
    expect(getPrimaryVariantId('components/C.tsx')).toBeUndefined();
  });

  it('returns undefined for a container-set file with no parseable config', () => {
    projectFS.writeFile('icons/Empty.tsx', `
/** @iconSet */
export default function Empty() { return null; }
`);
    expect(getPrimaryVariantId('icons/Empty.tsx')).toBeUndefined();
  });
});

// ─── extractComponentRootSize — slot consts + ternary roots (2026-07-28) ─────
// Make-component on the CTA section produced a master whose entry fit a
// ~350px marquee CARD at ~200% zoom: the root variants object had its
// width/height stripped (moved to the inline initialVariant ternary), and the
// "first data-id = root" scan landed on a module-scope `cn_` slot const
// declared above the function. Also, the ternary default-height heuristic
// read the LAST px anywhere ('553px', the mobile tile) instead of noticing
// the else branch is 'min-content'.
describe('extractComponentRootSize — slot consts and ternary roots', () => {
  const CTA_LIKE = `import React from 'react';
const variantConfig = [
  { name: 'default', label: 'Desktop', x: 0, y: 0, isPrimary: true },
  { name: 'variant-1', label: 'Tablet', x: 1728, y: 0 },
];
const frameRootVariants = {
  default: { padding: '95px', order: '10' },
  'variant-1': { padding: '23px' },
};
const cn_card_1 = <div data-id="card-1" data-canvas-node="true" style={{ position: 'absolute', width: '350px', height: '160px', left: '-382px', top: '0px' }}></div>;
function NuNuSe({ style, initialVariant = 'default' }) {
  return (
    <LayoutGroup>
    <motion.div data-id="frame-root" variants={frameRootVariants} style={{ display: 'flex', position: 'absolute', width: initialVariant === 'variant-1' ? '768px' : '1440px', height: initialVariant === 'variant-1' ? '537px' : 'min-content', ...style }}>
      <Marquee data-id="m1">{cn_card_1}</Marquee>
    </motion.div>
    </LayoutGroup>
  );
}
export default withResponsiveProps(NuNuSe);`;

  it('skips module-scope cn_ consts — reads the ROOT, not the card', () => {
    const size = extractComponentRootSize(CTA_LIKE, 'default');
    expect(size.width).toBe(1440);          // root ternary default, not the 350px card
    expect(size.width).not.toBe(350);
  });

  it("a 'min-content' else branch estimates from width instead of stealing another variant's px", () => {
    const size = extractComponentRootSize(CTA_LIKE, 'default');
    expect(size.estimated).toBe(true);
    expect(size.height).toBe(Math.round(1440 * 0.625));
    expect(size.height).not.toBe(537);      // never the tablet tile's height
  });

  it('a real px else branch still resolves as the default', () => {
    const code = CTA_LIKE.replace("initialVariant === 'variant-1' ? '537px' : 'min-content'", "initialVariant === 'variant-1' ? '537px' : '795px'");
    const size = extractComponentRootSize(code, 'default');
    expect(size).toEqual({ width: 1440, height: 795 });
  });

  it('focused non-default variant resolves its own ternary branch', () => {
    const size = extractComponentRootSize(CTA_LIKE, 'variant-1');
    expect(size).toEqual({ width: 768, height: 537 });
  });
});
