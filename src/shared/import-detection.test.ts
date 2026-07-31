// Tests for the shared framework-import detector.
//
// Two consumers depend on byte-for-byte identical output:
//   - mutation-queue.ts → syncImports (runtime, every flush)
//   - scripts/add-template-imports.mjs (one-shot template pre-bake)
//
// Drift between them silently breaks the live preview iframe — the canvas
// can lean on global CDN scripts, but the preview compiles real `import`
// statements through Babel. Pin the contract here.

import { describe, test, expect } from 'vitest';
// .mjs import — vitest resolves it via Vite's native ESM handling.
import { buildAutoImports } from './import-detection.mjs';

describe('buildAutoImports — React hooks', () => {
  test('emits bare React import when no hooks are used', () => {
    const out = buildAutoImports(`function Foo() { return <div/>; }`);
    expect(out).toEqual([`import React from 'react';`]);
  });

  test('detects every supported hook by bare-identifier match', () => {
    const body = `
      const [s, setS] = useState(0);
      useEffect(() => {}, []);
      const r = useRef(null);
      const cb = useCallback(() => {}, []);
      const m = useMemo(() => 1, []);
      useLayoutEffect(() => {}, []);
    `;
    const out = buildAutoImports(body);
    expect(out[0]).toBe(
      `import React, { useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect } from 'react';`
    );
  });

  test('preserves hook order — useState always first, useLayoutEffect last', () => {
    // Body deliberately uses hooks out of declaration order to prove the
    // emitted order comes from the helper, not from input order.
    const out = buildAutoImports(`useLayoutEffect; useState; useEffect;`);
    expect(out[0]).toBe(`import React, { useState, useEffect, useLayoutEffect } from 'react';`);
  });

  test('does NOT match a hook spelled inside another identifier', () => {
    // `myUseState` should NOT trigger a useState import — `\b` boundaries
    // protect against this. Without the word boundary the helper would
    // emit React, { useState } and dirty the diff for unrelated edits.
    const out = buildAutoImports(`const x = myUseState; const y = useStateFoo;`);
    expect(out).toEqual([`import React from 'react';`]);
  });
});

describe('buildAutoImports — framer-motion', () => {
  test('detects motion. member access', () => {
    const out = buildAutoImports(`<motion.div animate={{ x: 0 }}/>`);
    expect(out).toContain(`import { motion } from 'framer-motion';`);
  });

  test('detects AnimatePresence + scroll/spring/template/inView named hooks', () => {
    const body = `
      <AnimatePresence>
        <motion.div/>
      </AnimatePresence>
      const { scrollYProgress } = useScroll();
      const x = useTransform(scrollYProgress, [0,1], [0,100]);
      const s = useSpring(x);
      const t = useMotionTemplate\`translate(\${x}px)\`;
      const inView = useInView(ref);
    `;
    const out = buildAutoImports(body);
    expect(out).toContain(
      `import { motion, AnimatePresence, useScroll, useTransform, useSpring, useMotionTemplate, useInView } from 'framer-motion';`
    );
  });

  test('does NOT emit framer-motion line when nothing matches', () => {
    const out = buildAutoImports(`<div/>`);
    expect(out.some(l => l.includes('framer-motion'))).toBe(false);
  });
});

describe('buildAutoImports — Next.js shims', () => {
  test('emits next/link only when <Link> is used', () => {
    const withLink = buildAutoImports(`<Link href="/about">x</Link>`);
    expect(withLink).toContain(`import Link from 'next/link';`);
    const without = buildAutoImports(`<a href="/about">x</a>`);
    expect(without).not.toContain(`import Link from 'next/link';`);
  });

  test('emits next/link for the MotionLink wrapper (no literal <Link> tag)', () => {
    // `const MotionLink = motion.create(Link)` references Link without a
    // `<Link>` tag in the body — the rebuild must still import it.
    const out = buildAutoImports(`const MotionLink = motion.create(Link);\nfunction C(){return <MotionLink href="/a">x</MotionLink>;}`);
    expect(out).toContain(`import Link from 'next/link';`);
    expect(out.filter((l: string) => l.includes("next/link")).length).toBe(1);
  });

  test('emits next/image only when <Image> is used', () => {
    const withImage = buildAutoImports(`<Image src="/x.jpg" alt=""/>`);
    expect(withImage).toContain(`import Image from 'next/image';`);
    // Bare `Image` reference (e.g. `const i = new Image()`) doesn't match
    // because we require `<Image` as a JSX tag — avoids false positives
    // on the global Image constructor.
    const without = buildAutoImports(`const img = new Image();`);
    expect(without).not.toContain(`import Image from 'next/image';`);
  });
});

describe('buildAutoImports — composition', () => {
  test('motion hero — useState + motion + AnimatePresence', () => {
    const body = `
      const [open, setOpen] = useState(false);
      return <AnimatePresence><motion.div/></AnimatePresence>;
    `;
    const out = buildAutoImports(body);
    expect(out).toEqual([
      `import React, { useState } from 'react';`,
      `import { motion, AnimatePresence } from 'framer-motion';`,
    ]);
  });
});

describe('buildAutoImports — @revyme/runtime', () => {
  test('detects withResponsiveProps', () => {
    const out = buildAutoImports(`export default withResponsiveProps(Card);`);
    expect(out).toContain(`import { withResponsiveProps } from '@revyme/runtime';`);
  });

  test('detects withCursor (component cursor spread)', () => {
    const out = buildAutoImports(`return <div {...withCursor(Pointer, {})} />;`);
    expect(out).toContain(`import { withCursor } from '@revyme/runtime';`);
  });

  test('detects CursorPortal', () => {
    const out = buildAutoImports(`return <body><CursorPortal /></body>;`);
    expect(out).toContain(`import { CursorPortal } from '@revyme/runtime';`);
  });

  test('component master with a cursor variable keeps BOTH withResponsiveProps and withCursor', () => {
    // The exact regression: a master file imports withResponsiveProps AND
    // uses withCursor (cursor-as-variable). buildAutoImports owns the
    // @revyme/runtime line, so it must emit both — otherwise the rebuild
    // strips withCursor and the preview throws "withCursor is not defined".
    const body = `
      function NeBiCo({ style, test }) {
        return <div data-id="x" {...withCursor(test, { mode: 'follow' })} style={{ ...style }} />;
      }
      export default withResponsiveProps(NeBiCo);
    `;
    const out = buildAutoImports(body);
    expect(out).toContain(`import { withResponsiveProps, withCursor } from '@revyme/runtime';`);
  });
});

// ── RevymeSplitText (runtime text effects) ─────────────────────────────────
// syncImports DROPS the @revyme/runtime line and rebuilds it from this scan; an export
// missing here is silently deleted on the next flush → "RevymeSplitText is not defined".
const splitBody = (jsx: string) => `export default function Page() {
  return ${jsx};
}`;

describe('buildAutoImports — RevymeSplitText', () => {
  test('emits the import when the body references the component', () => {
    const lines = buildAutoImports(splitBody('<p data-id="x"><RevymeSplitText spec={{}}>Hi</RevymeSplitText></p>'));
    expect(lines.join('\n')).toContain("import { RevymeSplitText } from '@revyme/runtime';");
  });

  test('omits it when unreferenced', () => {
    expect(buildAutoImports(splitBody('<p data-id="x">Hi</p>')).join('\n')).not.toContain('RevymeSplitText');
  });

  test('shares one line with the other runtime exports', () => {
    const out = buildAutoImports(`export default withResponsiveProps(function Page() {
  return <p data-id="x"><RevymeSplitText spec={{}}>Hi</RevymeSplitText></p>;
})`).join('\n');
    const runtimeLines = out.split('\n').filter(l => l.includes('@revyme/runtime'));
    expect(runtimeLines).toHaveLength(1);
    expect(runtimeLines[0]).toContain('withResponsiveProps');
    expect(runtimeLines[0]).toContain('RevymeSplitText');
  });
});
