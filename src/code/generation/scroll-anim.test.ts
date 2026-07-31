import { describe, it, expect } from 'vitest';
import { updateScrollAnimInCode, removeScrollAnimFromCode, ScrollAnimConfig, detectLayerRangeFromOffset } from './generator-motion';
import { parseScrollHooks, getMultiSectionForNode } from '../parsing/scroll-parser';

// ─── Test: AI-generated code with non-matching variable names ──────────────

const AI_GENERATED_CODE = `import { motion, useScroll, useTransform, useSpring, useRef } from 'framer-motion';
export default function Page() {
  const heroRef = useRef(null);
  const { scrollYProgress: heroProgress } = useScroll({ target: heroRef, offset: ["start start", "end start"] });
  const heroScale = useTransform(heroProgress, [0, 1], [1, 0.85]);
  const heroRadius = useTransform(heroProgress, [0, 1], ["0px", "60px"]);
  const heroOpacity = useTransform(heroProgress, [0, 0.8], [1, 0]);

  return (
    <div data-id="root">
      <div data-id="hero-wrapper" ref={heroRef} style={{ height: '150vh' }}>
        <motion.div
          data-id="hero-sticky"
          style={{
            position: 'sticky',
            top: 0,
            scale: heroScale,
            borderRadius: heroRadius,
            opacity: heroOpacity
          }}
        />
      </div>
    </div>
  );
}`;

describe('updateScrollAnimInCode', () => {
  it('replaces AI-generated hooks with different naming convention', () => {
    const config: ScrollAnimConfig = {
      nodeId: 'hero-sticky',
      trigger: 'sectionInView',
      stops: [
        { progress: 0, props: { scale: '1' } },
        { progress: 1, props: { scale: '1.05' } },
      ],
    };

    const result = updateScrollAnimInCode(AI_GENERATED_CODE, config);

    // Old AI-generated hooks should be GONE
    expect(result).not.toContain('const heroScale = useTransform(heroProgress');
    expect(result).not.toContain('const heroRadius = useTransform(heroProgress');
    expect(result).not.toContain('const heroOpacity = useTransform(heroProgress');
    expect(result).not.toContain('const heroRef = useRef');
    expect(result).not.toContain('scrollYProgress: heroProgress');

    // New cleanName-based hooks should exist
    expect(result).toContain('const heroStickyScale = useTransform(heroStickyProgress');
    expect(result).toContain('heroStickyRef');
    expect(result).toContain('heroStickyProgress');

    // Ref should be placed on hero-wrapper (where the old ref was), NOT on hero-sticky
    // ref is inserted before data-id: <div ref={heroStickyRef} data-id="hero-wrapper">
    expect(result).toMatch(/ref=\{heroStickyRef\}[^>]*data-id="hero-wrapper"/s);
    expect(result).not.toMatch(/ref=\{heroStickyRef\}[^>]*data-id="hero-sticky"/s);

    // Style should bind to new var
    expect(result).toContain('scale: heroStickyScale');
    // Old style bindings should be gone
    expect(result).not.toMatch(/scale:\s*heroScale/);
    expect(result).not.toMatch(/borderRadius:\s*heroRadius/);
    expect(result).not.toMatch(/opacity:\s*heroOpacity/);
  });

  it('places ref on same element when ref was originally on nodeId', () => {
    // Ref is directly on the animated element (no parent separation)
    const directRefCode = `import { motion, useScroll, useTransform, useRef } from 'framer-motion';
export default function Page() {
  const myRef = useRef(null);
  const { scrollYProgress: myProgress } = useScroll({ target: myRef, offset: ["start end", "end start"] });
  const myOpacity = useTransform(myProgress, [0, 1], [0, 1]);

  return (
    <div data-id="root">
      <motion.div ref={myRef} data-id="section-a" style={{ opacity: myOpacity }} />
    </div>
  );
}`;

    const config: ScrollAnimConfig = {
      nodeId: 'section-a',
      trigger: 'layerInView',
      stops: [
        { progress: 0, props: { opacity: '0' } },
        { progress: 1, props: { opacity: '1' } },
      ],
    };

    const result = updateScrollAnimInCode(directRefCode, config);

    // Ref should stay on section-a (same element)
    expect(result).toMatch(/ref=\{sectionARef\}[^>]*data-id="section-a"|data-id="section-a"[^>]*ref=\{sectionARef\}/s);
  });

  it('preserves shared scroll sources when another node uses them', () => {
    // Two nodes share the same scroll source (heroProgress drives both hero-sticky and hero-deco)
    const sharedCode = `import { motion, useScroll, useTransform, useRef } from 'framer-motion';
export default function Page() {
  const heroRef = useRef(null);
  const { scrollYProgress: heroProgress } = useScroll({ target: heroRef, offset: ["start start", "end start"] });
  const heroScale = useTransform(heroProgress, [0, 1], [1, 0.85]);
  const decoOpacity = useTransform(heroProgress, [0, 1], [1, 0]);

  return (
    <div data-id="root">
      <div data-id="hero-wrapper" ref={heroRef} style={{ height: '150vh' }}>
        <motion.div data-id="hero-sticky" style={{ scale: heroScale }} />
        <motion.div data-id="hero-deco" style={{ opacity: decoOpacity }} />
      </div>
    </div>
  );
}`;

    const config: ScrollAnimConfig = {
      nodeId: 'hero-sticky',
      trigger: 'sectionInView',
      stops: [
        { progress: 0, props: { scale: '1' } },
        { progress: 1, props: { scale: '1.2' } },
      ],
    };

    const result = updateScrollAnimInCode(sharedCode, config);

    // heroScale should be removed (bound to hero-sticky)
    expect(result).not.toContain('const heroScale = useTransform');

    // decoOpacity should REMAIN (bound to hero-deco, different node)
    expect(result).toContain('const decoOpacity = useTransform(heroProgress');

    // heroProgress and heroRef should REMAIN (shared source)
    expect(result).toContain('heroProgress');
    expect(result).toContain('heroRef');

    // New hooks for hero-sticky should be added
    expect(result).toContain('heroStickyScale');
  });

  it('works when cleanName matches (builder-generated hooks)', () => {
    // Code where hooks already follow our cleanName pattern
    const builderCode = `import { motion, useScroll, useTransform, useRef } from 'framer-motion';
export default function Page() {
  const heroStickyRef = useRef(null);
  const { scrollYProgress: heroStickyProgress } = useScroll({ target: heroStickyRef, offset: ["start end", "end start"] });
  const heroStickyScale = useTransform(heroStickyProgress, [0, 1], [1, 0.85]);

  return (
    <div data-id="root">
      <motion.div ref={heroStickyRef} data-id="hero-sticky" style={{ scale: heroStickyScale }} />
    </div>
  );
}`;

    const config: ScrollAnimConfig = {
      nodeId: 'hero-sticky',
      trigger: 'sectionInView',
      stops: [
        { progress: 0, props: { scale: '1' } },
        { progress: 1, props: { scale: '1.2' } },
      ],
    };

    const result = updateScrollAnimInCode(builderCode, config);

    // Should not have duplicates
    const scaleMatches = result.match(/const heroStickyScale/g);
    expect(scaleMatches).toHaveLength(1);

    // Should have updated output range
    expect(result).toContain('[1, 1.2]');
  });

  it('handles short mnemonic AI names (p1, y1a, etc.)', () => {
    const mnemonicCode = `import { motion, useScroll, useTransform, useRef } from 'framer-motion';
export default function Page() {
  const r1 = useRef(null);
  const { scrollYProgress: p1 } = useScroll({ target: r1, offset: ["start end", "end start"] });
  const y1a = useTransform(p1, [0, 1], ["-100px", "100px"]);

  return (
    <div data-id="root">
      <div data-id="sec1-container" ref={r1} style={{ height: '150vh' }}>
        <motion.div data-id="sec1-img-1" style={{ y: y1a }} />
      </div>
    </div>
  );
}`;

    const config: ScrollAnimConfig = {
      nodeId: 'sec1-img-1',
      trigger: 'layerInView',
      stops: [
        { progress: 0, props: { y: '-200' } },
        { progress: 1, props: { y: '200' } },
      ],
    };

    const result = updateScrollAnimInCode(mnemonicCode, config);

    // Old mnemonic hooks should be gone
    expect(result).not.toContain('const y1a = useTransform');
    expect(result).not.toMatch(/y:\s*y1a/);

    // New hooks should exist (sec1-img-1 → sec1Img_1 because _([a-z]) doesn't match _1)
    expect(result).toContain('sec1Img_1Y');
    expect(result).toContain('sec1Img_1Progress');
  });

  it('decomposes clipPath into useMotionTemplate + individual useTransform calls', () => {
    const simpleCode = `import { motion, useScroll, useTransform, useRef } from 'framer-motion';
export default function Page() {
  return (
    <div data-id="root">
      <motion.div data-id="box" style={{ opacity: 1 }} />
    </div>
  );
}`;

    const config: ScrollAnimConfig = {
      nodeId: 'box',
      trigger: 'layerInView',
      stops: [
        { progress: 0, props: { clipPath: 'polygon(20% 0%, 80% 0%, 100% 100%, 0% 100%)' } },
        { progress: 1, props: { clipPath: 'polygon(0% 0%, 100% 0%, 80% 100%, 20% 100%)' } },
      ],
    };

    const result = updateScrollAnimInCode(simpleCode, config);

    // Should have individual useTransform for each numeric value
    expect(result).toContain('boxClipPath_0 = useTransform');
    expect(result).toContain('boxClipPath_1 = useTransform');
    // Should have useMotionTemplate composing them
    expect(result).toContain('useMotionTemplate');
    // Should import useMotionTemplate
    expect(result).toContain('useMotionTemplate');
    // Should NOT have a direct string useTransform for clipPath
    expect(result).not.toContain('useTransform(boxProgress, [0, 1], ["polygon');
    // Style should bind to the template var
    expect(result).toContain('clipPath: boxClipPath');
  });

  it('keeps simple values as direct useTransform (no decomposition)', () => {
    const simpleCode = `import { motion, useScroll, useTransform, useRef } from 'framer-motion';
export default function Page() {
  return (
    <div data-id="root">
      <motion.div data-id="box" style={{ opacity: 1 }} />
    </div>
  );
}`;

    const config: ScrollAnimConfig = {
      nodeId: 'box',
      trigger: 'layerInView',
      stops: [
        { progress: 0, props: { opacity: '1', borderRadius: '0px' } },
        { progress: 1, props: { opacity: '0', borderRadius: '60px' } },
      ],
    };

    const result = updateScrollAnimInCode(simpleCode, config);

    // Simple values should use direct useTransform, not decomposition
    expect(result).toContain('boxOpacity = useTransform(boxProgress, [0, 1], [1, 0])');
    expect(result).toContain('boxBorderRadius = useTransform(boxProgress, [0, 1], ["0px", "60px"])');
    // Should NOT use useMotionTemplate
    expect(result).not.toContain('useMotionTemplate');
  });
});

describe('detectLayerRangeFromOffset', () => {
  it('decodes "start 70%" back to range 0.3', () => {
    expect(detectLayerRangeFromOffset(`["start end", "start 70%"]`)).toBe('0.30000000000000004');
    // Floating-point noise is fine — the editor's slider clamps display
    // to 2 decimals and the round-trip stays semantically equivalent.
  });

  it('decodes "start 0%" to range 1', () => {
    expect(detectLayerRangeFromOffset(`["start end", "start 0%"]`)).toBe('1');
  });

  it('returns null for legacy "end start" offset (full pass-through)', () => {
    expect(detectLayerRangeFromOffset(`["start end", "end start"]`)).toBeNull();
  });

  it('returns null for the snappy "end end" default', () => {
    expect(detectLayerRangeFromOffset(`["start end", "end end"]`)).toBeNull();
  });
});

describe('updateScrollAnimInCode – layerInView range', () => {
  const STARTER_LIV = `import React, { useRef } from 'react';

export default function Page() {
  return (
    <div data-id="root">
      <div data-id="box" style={{}} />
    </div>
  );
}`;

  it('emits offset endpoint based on layerRange (0.3 → "start 70%")', () => {
    const config: ScrollAnimConfig = {
      nodeId: 'box',
      trigger: 'layerInView',
      layerRange: '0.3',
      stops: [
        { progress: 0, props: { opacity: '0' } },
        { progress: 1, props: { opacity: '1' } },
      ],
      transition: { type: 'instant' },
    };
    const result = updateScrollAnimInCode(STARTER_LIV, config);
    expect(result).toContain(`offset: ["start end", "start 70%"]`);
  });

  it('emits "start 0%" for layerRange 1.0 (full viewport pass)', () => {
    const config: ScrollAnimConfig = {
      nodeId: 'box',
      trigger: 'layerInView',
      layerRange: '1',
      stops: [
        { progress: 0, props: { opacity: '0' } },
        { progress: 1, props: { opacity: '1' } },
      ],
      transition: { type: 'instant' },
    };
    const result = updateScrollAnimInCode(STARTER_LIV, config);
    expect(result).toContain(`offset: ["start end", "start 0%"]`);
  });

  it('falls back to the default snappy offset when no layerRange given', () => {
    const config: ScrollAnimConfig = {
      nodeId: 'box',
      trigger: 'layerInView',
      stops: [
        { progress: 0, props: { opacity: '0' } },
        { progress: 1, props: { opacity: '1' } },
      ],
      transition: { type: 'instant' },
    };
    const result = updateScrollAnimInCode(STARTER_LIV, config);
    // Default from SCROLL_TRIGGER_OFFSETS.layerInView = "end end"
    expect(result).toContain(`offset: ["start end", "end end"]`);
  });
});

describe('updateScrollAnimInCode – multi-section', () => {
  const STARTER = `import React, { useState, useEffect, useRef } from 'react';

export default function Page() {
  return (
    <div data-id="root">
      <div data-id="hero" style={{}} />
    </div>
  );
}`;

  it('emits N section refs + positions state + per-prop useTransform with held tail', () => {
    const config: ScrollAnimConfig = {
      nodeId: 'hero',
      trigger: 'sectionInView',
      sectionId: '',
      sectionViewport: 'middle',
      fromProps: { opacity: '0', rotate: '0' },
      sections: [
        { sectionId: 'about',   props: { opacity: '0.5', rotate: '45' } },
        { sectionId: 'contact', props: { opacity: '1',   rotate: '90' } },
      ],
      stops: [],
      transition: { type: 'instant' },
    };
    const result = updateScrollAnimInCode(STARTER, config);
    expect(result).toContain('useRef(null)');
    expect(result).toContain("document.getElementById('about')");
    expect(result).toContain("document.getElementById('contact')");
    expect(result).toContain('useState');
    expect(result).toContain('window.addEventListener(\'resize\', compute)');
    // Page-level useScroll (no target arg)
    expect(result).toMatch(/useScroll\(\s*\)/);
    // Output ranges hold the last value: [from, s0, s1, s1]
    expect(result).toMatch(/useTransform\([^)]+\[0,\s*\d/);
    expect(result).toMatch(/\[\s*0\s*,\s*0\.5\s*,\s*1\s*,\s*1\s*\]/);  // opacity output
    expect(result).toMatch(/\[\s*0\s*,\s*45\s*,\s*90\s*,\s*90\s*\]/);  // rotate output
  });

  it('uses 0 as offsetPx for top viewport', () => {
    const config: ScrollAnimConfig = {
      nodeId: 'hero',
      trigger: 'sectionInView',
      sectionId: '',
      sectionViewport: 'top',
      fromProps: { opacity: '0' },
      sections: [
        { sectionId: 'a', props: { opacity: '0.5' } },
        { sectionId: 'b', props: { opacity: '1'   } },
      ],
      stops: [],
      transition: { type: 'instant' },
    };
    const result = updateScrollAnimInCode(STARTER, config);
    expect(result).toMatch(/const offsetPx\s*=\s*0\s*;/);
  });

  it('forward-fills motion-transform props from the rest neutral, not the first section value', () => {
    // User adds `rotate` only on Section 1. The animation should START
    // from the motion-neutral rest value (rotate:0) and animate INTO
    // rotate:45 by Section 1, then hold at 45 for the remaining sections.
    // Earlier versions backfilled From with the first known section
    // value (45), producing a no-op pre-rotated state.
    const config: ScrollAnimConfig = {
      nodeId: 'hero',
      trigger: 'sectionInView',
      sectionViewport: 'middle',
      fromProps: { opacity: '0' },
      sections: [
        { sectionId: 'a', props: { opacity: '1', rotate: '45' } },
        { sectionId: 'b', props: { opacity: '1' } },                  // no rotate
        { sectionId: 'c', props: { opacity: '1' } },                  // no rotate
      ],
      stops: [],
      transition: { type: 'instant' },
    };
    const result = updateScrollAnimInCode(STARTER, config);
    // Output for rotate: [from=0 (neutral), s0=45, s1=45 (held), s2=45, last=45]
    expect(result).toMatch(/useTransform\([^)]+\[\s*0\s*,\s*45\s*,\s*45\s*,\s*45\s*,\s*45\s*\]/);
  });

  it('uses JSX rest value (not first known section) for CSS prop backfill', () => {
    // Regression: when backgroundColor is set only on Section 2, the
    // output range was [#c52d2d, #c52d2d, #c52d2d, #c52d2d] → red
    // already at page load (no animation). We now backfill From and
    // pre-section-2 stops with the AUTHORED static value from the
    // element's JSX style (#97cffc), so the chain becomes
    //   From=#97cffc → Sec1=#97cffc → Sec2=#c52d2d → hold=#c52d2d
    // and the animation actually fires when Section 2 enters view.
    const STARTER_WITH_BG = `import React, { useState, useEffect, useRef } from 'react';

export default function Page() {
  return (
    <div data-id="root">
      <div data-id="hero" style={{ backgroundColor: '#97cffc' }} />
    </div>
  );
}`;
    const config: ScrollAnimConfig = {
      nodeId: 'hero',
      trigger: 'sectionInView',
      sectionViewport: 'middle',
      fromProps: { opacity: '0' },
      sections: [
        { sectionId: 'a', props: { opacity: '0.5' } },                            // no bg
        { sectionId: 'b', props: { opacity: '1', backgroundColor: '#c52d2d' } },  // bg set
      ],
      stops: [],
      transition: { type: 'instant' },
    };
    const result = updateScrollAnimInCode(STARTER_WITH_BG, config);
    expect(result).toMatch(/useTransform\([^)]+\[\s*"#97cffc"\s*,\s*"#97cffc"\s*,\s*"#c52d2d"\s*,\s*"#c52d2d"\s*\]/);
  });

  it('round-trips through parser: generator → parseScrollHooks → block matches input', () => {
    const config: ScrollAnimConfig = {
      nodeId: 'hero',
      trigger: 'sectionInView',
      sectionId: '',
      sectionViewport: 'middle',
      fromProps: { opacity: '0', rotate: '0' },
      sections: [
        { sectionId: 'about',   props: { opacity: '0.5', rotate: '45' } },
        { sectionId: 'contact', props: { opacity: '1',   rotate: '90' } },
      ],
      stops: [],
      transition: { type: 'instant' },
    };
    const result = updateScrollAnimInCode(STARTER, config);
    const data = parseScrollHooks(result);
    const block = getMultiSectionForNode(data, 'hero');
    expect(block).not.toBeNull();
    expect(block!.sectionViewport).toBe('middle');
    expect(block!.sections.map(s => s.sectionId)).toEqual(['about', 'contact']);
    expect(block!.fromProps.opacity).toBe('0');
    expect(block!.sections[1].props.opacity).toBe('1');
  });

  it('uses window.innerHeight as offsetPx for bottom viewport', () => {
    const config: ScrollAnimConfig = {
      nodeId: 'hero',
      trigger: 'sectionInView',
      sectionId: '',
      sectionViewport: 'bottom',
      fromProps: { opacity: '0' },
      sections: [
        { sectionId: 'a', props: { opacity: '0.5' } },
        { sectionId: 'b', props: { opacity: '1'   } },
      ],
      stops: [],
      transition: { type: 'instant' },
    };
    const result = updateScrollAnimInCode(STARTER, config);
    expect(result).toMatch(/const offsetPx\s*=\s*window\.innerHeight\s*;/);
  });
});

describe('removeScrollAnimFromCode – multi-section cleanup', () => {
  it('strips section refs, positions state, and mount effect when removing a multi-section-animated node', () => {
    const MULTI_SOURCE = `import React, { useState, useEffect, useRef } from 'react';

export default function Page() {
  const heroSec0Ref = useRef(null);
  const heroSec1Ref = useRef(null);
  const [heroSecPositions, setHeroSecPositions] = useState(() => Array(2).fill(0));
  useEffect(() => {
    heroSec0Ref.current = document.getElementById('a');
    heroSec1Ref.current = document.getElementById('b');
    const compute = () => { setHeroSecPositions([0, 0]); };
    compute();
  }, []);
  const { scrollYProgress: heroProgress } = useScroll();
  const heroSmooth = useSpring(heroProgress, { duration: 0.5, bounce: 0.25 });
  const heroOpacity = useTransform(heroSmooth, [0, heroSecPositions[0], heroSecPositions[1], 1], [0, 0.5, 1, 1]);
  return (
    <div data-id="root">
      <motion.div data-id="hero" style={{ opacity: heroOpacity }} />
    </div>
  );
}`;
    const result = removeScrollAnimFromCode(MULTI_SOURCE, 'hero');
    // All hero-specific scroll artifacts must be gone.
    expect(result).not.toMatch(/heroSec\d+Ref/);
    expect(result).not.toMatch(/heroSecPositions/);
    expect(result).not.toMatch(/setHeroSecPositions/);
    expect(result).not.toContain('heroProgress');
    expect(result).not.toContain('heroSmooth');
    expect(result).not.toContain('heroOpacity');
    // No useEffect CALL (the import line is allowed to mention the name).
    expect(result).not.toMatch(/useEffect\s*\(/);
  });
});

describe('removeScrollAnimFromCode', () => {
  it('removes AI-generated hooks with non-matching variable names', () => {
    const result = removeScrollAnimFromCode(AI_GENERATED_CODE, 'hero-sticky');

    // All hooks bound to hero-sticky should be gone
    expect(result).not.toContain('const heroScale');
    expect(result).not.toContain('const heroRadius');
    expect(result).not.toContain('const heroOpacity');

    // Source + ref should be gone (only hero-sticky used them)
    expect(result).not.toContain('const heroRef');
    expect(result).not.toContain('heroProgress');

    // Style bindings should be gone
    expect(result).not.toMatch(/scale:\s*heroScale/);
    expect(result).not.toMatch(/borderRadius:\s*heroRadius/);
    expect(result).not.toMatch(/opacity:\s*heroOpacity/);

    // Static styles should remain
    expect(result).toContain("position: 'sticky'");
  });

  it('preserves shared sources when removing one node', () => {
    const sharedCode = `import { motion, useScroll, useTransform, useRef } from 'framer-motion';
export default function Page() {
  const heroRef = useRef(null);
  const { scrollYProgress: heroProgress } = useScroll({ target: heroRef, offset: ["start start", "end start"] });
  const heroScale = useTransform(heroProgress, [0, 1], [1, 0.85]);
  const decoY = useTransform(heroProgress, [0, 1], ["0px", "50px"]);

  return (
    <div data-id="root">
      <div data-id="hero-wrapper" ref={heroRef} style={{ height: '150vh' }}>
        <motion.div data-id="hero-sticky" style={{ scale: heroScale }} />
        <motion.div data-id="hero-deco" style={{ y: decoY }} />
      </div>
    </div>
  );
}`;

    const result = removeScrollAnimFromCode(sharedCode, 'hero-sticky');

    // heroScale should be removed
    expect(result).not.toContain('const heroScale');
    expect(result).not.toMatch(/scale:\s*heroScale/);

    // decoY, heroProgress, heroRef should remain (used by hero-deco)
    expect(result).toContain('const decoY = useTransform(heroProgress');
    expect(result).toContain('heroProgress');
    expect(result).toContain('heroRef');
  });
});

// ─── Spring-chained target-ref parallax removal (the works-grid columns) ─────
// The MCP-authored parallax shape chains useScroll → useSpring → useTransform
// with a TARGET ref on the tracked element. Removal must clean the WHOLE chain
// (hooks + ref attr + style binding + no dangling identifiers) — a partial
// removal leaves an undefined identifier, and validateGeneratedCode blocks the
// entire mutation batch, so the tool appears to "not delete" (live 2026-07-07).
describe('removeScrollAnimFromCode — spring-chained target-ref parallax', () => {
  const PARALLAX = `'use client';
import React, { useRef } from 'react';
import { motion, useScroll, useTransform, useSpring } from 'framer-motion';
export default function Page() {
  const colARef = useRef(null);
  const { scrollYProgress: colAProgress } = useScroll({ target: colARef, offset: ["start end", "start 70%"] });
  const colASmooth = useSpring(colAProgress, { duration: 0.5, bounce: 0.25 });
  const colAY = useTransform(colASmooth, [0, 1], [0, -106]);
  return <div data-id="root" data-name="Page" style={{ position: 'relative', width: '100%', display: 'flex', flexDirection: 'column' }}>
    <motion.div ref={colARef} data-id="col-a" data-name="Column A" style={{ position: 'relative', order: '0', flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: '30px', y: colAY }}></motion.div>
  </div>;
}`;

  it('removes hooks, ref attribute, and style binding completely', () => {
    const out = removeScrollAnimFromCode(PARALLAX, 'col-a');
    for (const name of ['colARef', 'colAProgress', 'colASmooth', 'colAY']) {
      expect(out).not.toContain(name);
    }
    expect(out).not.toMatch(/y:\s*colAY/);
    // No dangling identifiers — the batch must survive validateGeneratedCode.
    expect(out).toContain('data-id="col-a"'); // element itself stays
  });

  it('is a no-op when invoked with a node that has no scroll bindings', () => {
    const out = removeScrollAnimFromCode(PARALLAX, 'root');
    expect(out).toBe(PARALLAX);
  });
});
