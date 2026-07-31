import { describe, test, expect } from 'vitest';
import { parseJSXToNodes } from './parser';

describe('parseJSXToNodes', () => {
  test('parses basic div with data-id and styles', () => {
    const code = `<div data-id="box" style={{left: '10px', top: '20px', width: '100px'}}></div>`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.size).toBe(1);
    const box = nodes.get('box');
    expect(box).toBeDefined();
    expect(box!.id).toBe('box');
    expect(box!.styles.left).toBe('10px');
    expect(box!.styles.top).toBe('20px');
    expect(box!.styles.width).toBe('100px');
  });

  test('parses nested parent-child relationships', () => {
    const code = `<div data-id="parent" style={{width: '400px'}}>
      <div data-id="child" style={{width: '200px'}}></div>
    </div>`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.size).toBe(2);

    const parent = nodes.get('parent')!;
    const child = nodes.get('child')!;

    expect(parent.children).toContain('child');
    expect(child.parentId).toBe('parent');
  });

  test('Glide wrappers (data-glide-item) are transparent — children attach to the glide container, siblings unaffected', () => {
    // The Glide effect wraps each child in <motion.div data-glide-item layout> inside
    // a <LayoutGroup>. Both must be invisible to the editor: children attach to the
    // glide container, and — critically — the enter-skip and exit-skip must be
    // symmetric so a sibling AFTER the glide container isn't re-parented (the
    // "component internals leak to root / FAQs scattered" bug).
    const code = `<div data-id="root">
      <div data-id="faq-list" data-glide='{"transition":{"type":"spring"}}'>
        <LayoutGroup>
          <motion.div data-glide-item layout style={{ order: '0' }}><FAQItem data-id="faq-1" /></motion.div>
          <motion.div data-glide-item layout style={{ order: '1' }}><FAQItem data-id="faq-2" /></motion.div>
        </LayoutGroup>
      </div>
      <div data-id="after"></div>
    </div>`;
    const nodes = parseJSXToNodes(code);
    // No node created for the wrappers/LayoutGroup — exactly root, faq-list, faq-1, faq-2, after.
    expect(new Set(nodes.keys())).toEqual(new Set(['root', 'faq-list', 'faq-1', 'faq-2', 'after']));
    // Children attach directly to the glide container.
    expect(nodes.get('faq-list')!.children).toEqual(['faq-1', 'faq-2']);
    expect(nodes.get('faq-1')!.parentId).toBe('faq-list');
    expect(nodes.get('faq-2')!.parentId).toBe('faq-list');
    // The glide spec survives on the container for the tool to read.
    expect(nodes.get('faq-list')!.attrs!['data-glide']).toContain('spring');
    // Sibling after the glide container is still parented to root (no over-pop corruption).
    expect(nodes.get('after')!.parentId).toBe('root');
    expect(nodes.get('root')!.children).toEqual(['faq-list', 'after']);
  });

  test('captures expression-form nav attrs as var: bindings (link variables)', () => {
    // After a nav attr becomes a component variable, the master JSX carries an
    // expression-form attr. The LinkTool reads these `var:` markers to render
    // the purple bound pill instead of the live control.
    const code = `<a data-id="lnk" href={linkHref} target={newTab ? '_blank' : undefined} data-smooth-scroll={smooth ? 'true' : undefined}>x</a>`;
    const nodes = parseJSXToNodes(code);
    const lnk = nodes.get('lnk')!;
    expect(lnk.attrs!.href).toBe('var:linkHref');
    expect(lnk.attrs!.target).toBe('var:newTab');
    expect(lnk.attrs!['data-smooth-scroll']).toBe('var:smooth');
  });

  test('captures var: nav attrs on a MotionLink (motion.create(Link) wrapper)', () => {
    // The master's link element is a `<MotionLink>` (uppercase). Without the
    // link-like special case it would fall into the component-prop path and
    // the href variable would never surface as a `var:` for the bound pill.
    const code = `import Link from 'next/link';
import { motion } from 'framer-motion';
const MotionLink = motion.create(Link);
function Card({ linkHref = '' }) {
  return <MotionLink data-id="lnk" href={linkHref} target={newTab ? '_blank' : undefined} style={{}}></MotionLink>;
}
export default Card;`;
    const nodes = parseJSXToNodes(code);
    const lnk = nodes.get('lnk')!;
    expect(lnk.type).toBe('MotionLink');
    expect(lnk.attrs!.href).toBe('var:linkHref');
    expect(lnk.attrs!.target).toBe('var:newTab');
  });

  test('parses NEGATIVE numeric motion props in variant objects (e.g. rotate: -13.3)', () => {
    // Regression: the variant-object regex matched only positive numbers, so a
    // negative `rotate` was dropped → the canvas tile fell back to the base
    // angle while live preview animated correctly.
    const code = `import { motion } from 'framer-motion';
const barVariants = {
  default: { backgroundColor: '#000', rotate: 14.1 },
  'variant-1': { rotate: -13.3 },
};
function Comp() {
  return <motion.div data-id="bar" variants={barVariants} style={{}}></motion.div>;
}`;
    const nodes = parseJSXToNodes(code);
    const bar = nodes.get('bar')!;
    expect(bar.motionVariants!.default.rotate).toBe('14.1');
    expect(bar.motionVariants!['variant-1'].rotate).toBe('-13.3');
  });

  test('parses QUOTED CSS custom-property keys in variant objects (overlay-border detach)', () => {
    // An overlay-border variable detached per variant writes `'--X': 'none'` into the variant
    // object. The key is quoted + hyphenated, so the bare-identifier path missed it → the
    // variant came back empty and the detach was invisible to the control + the canvas.
    const code = `import { motion } from 'framer-motion';
const barVariants = {
  default: {},
  'variant-1': { '--azefazef': 'none' },
};
function Comp() {
  return <motion.div data-id="bar" variants={barVariants} style={{ "--azefazef": '' }}></motion.div>;
}`;
    const bar = parseJSXToNodes(code).get('bar')!;
    expect(bar.motionVariants!['variant-1']['--azefazef']).toBe('none');
  });

  test('parses a NEGATIVE unquoted numeric in an inline style (e.g. rotate: -27.7)', () => {
    // make-component writes motion props unquoted; a negative is a
    // UnaryExpression that the inline-style parser must read, else the canvas
    // can't resolve the rotation.
    const code = `import { motion } from 'framer-motion';
function Comp() {
  return <motion.div data-id="bar" style={{ left: '10px', rotate: -27.7 }}></motion.div>;
}`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('bar')!.styles!.rotate).toBe('-27.7');
  });

  test('captures data-revyme-track as a var: on ANY element (tracking variable)', () => {
    // Tracking is variable-able on any element (not just links). The master
    // carries `data-revyme-track={trackingId}` — captured for the bound pill.
    const code = `function Card({ trackingId = '' }) {
  return <motion.div data-id="box" data-revyme-track={trackingId} style={{}}></motion.div>;
}`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('box')!.attrs!['data-revyme-track']).toBe('var:trackingId');
  });

  test('literal data-revyme-track stays literal', () => {
    const code = `<div data-id="box" data-revyme-track="signup-cta"></div>`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('box')!.attrs!['data-revyme-track']).toBe('signup-cta');
  });

  test('captures rel + data-keep-params on a link (literal and var)', () => {
    const lit = parseJSXToNodes(`<a data-id="lnk" href="/x" rel="nofollow noreferrer" data-keep-params="true"></a>`);
    expect(lit.get('lnk')!.attrs!.rel).toBe('nofollow noreferrer');
    expect(lit.get('lnk')!.attrs!['data-keep-params']).toBe('true');

    const v = parseJSXToNodes(`const MotionLink = motion.create(Link);
function C({ relTokens = '', keepParams = false }) {
  return <MotionLink data-id="lnk" href="/x" rel={relTokens} data-keep-params={keepParams ? "true" : undefined}></MotionLink>;
}`);
    expect(v.get('lnk')!.attrs!.rel).toBe('var:relTokens');
    expect(v.get('lnk')!.attrs!['data-keep-params']).toBe('var:keepParams');
  });

  test('literal href on a MotionLink stays literal (detached state)', () => {
    const code = `const MotionLink = motion.create(Link);
function Card() {
  return <MotionLink data-id="lnk" href="/about" style={{}}></MotionLink>;
}
export default Card;`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('lnk')!.attrs!.href).toBe('/about');
  });

  test('captures var: nav attrs on motion.* elements (component masters)', () => {
    // Masters convert every element to motion.* — tagName resolves to 'a', so
    // the lowercase htmlAttr branch still runs and the pill shows.
    const code = `<motion.a data-id="lnk" href={linkHref} target={newTab ? '_blank' : undefined}>x</motion.a>`;
    const nodes = parseJSXToNodes(code);
    const lnk = nodes.get('lnk')!;
    expect(lnk.attrs!.href).toBe('var:linkHref');
    expect(lnk.attrs!.target).toBe('var:newTab');
  });

  test('literal nav attrs stay literal (no var: prefix)', () => {
    const code = `<a data-id="lnk" href="/about" target="_blank">x</a>`;
    const nodes = parseJSXToNodes(code);
    const lnk = nodes.get('lnk')!;
    expect(lnk.attrs!.href).toBe('/about');
    expect(lnk.attrs!.target).toBe('_blank');
  });

  test('parses text content from JSX children', () => {
    const code = `<p data-id="text" style={{fontSize: '16px'}}>Hello World</p>`;
    const nodes = parseJSXToNodes(code);
    const text = nodes.get('text')!;
    expect(text.textContent).toBe('Hello World');
  });

  test('plain <span> runs inside a text node collapse into one rich-text node', () => {
    const code = `<p data-id="text" style={{}}>Hello<span style={{color:'red'}}>!</span></p>`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.size).toBe(1);
    expect(nodes.get('text')!.hasMixedContent).toBe(true);
    expect(nodes.get('text')!.children).toEqual([]);
  });

  test('motion.span runs collapse into one rich-text node, not separate selectable nodes', () => {
    // Component-master files convert every element to motion.* — the inline
    // text runs become <motion.span>. They must still register as inline
    // markup (one text node), NOT as individually-selectable child nodes.
    const code = `<motion.p data-id="logo" style={{display:'flex'}}>` +
      `<motion.span layout={true} style={{color:'red'}}>Esprithai</motion.span>` +
      `<motion.span layout={true} style={{color:'blue'}}>.</motion.span>` +
      `</motion.p>`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.size).toBe(1);
    const logo = nodes.get('logo')!;
    expect(logo.hasMixedContent).toBe(true);
    expect(logo.children).toEqual([]);
  });

  test('parses data-name attribute', () => {
    const code = `<div data-id="hero" data-name="Hero Section" style={{}}></div>`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('hero')!.name).toBe('Hero Section');
  });

  test('assigns auto IDs when data-id is missing', () => {
    const code = `<div style={{width: '100px'}}></div>`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.size).toBe(1);
    const node = nodes.values().next().value!;
    expect(node.id).toMatch(/^auto_/);
  });

  test('returns empty map on invalid JSX', () => {
    const code = `this is not valid jsx {{{}}}`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.size).toBe(0);
  });

  test('parses multiple root elements', () => {
    // Fragment-style: parser should handle multiple siblings
    const code = `<div data-id="root" style={{}}>
      <div data-id="a" style={{}}></div>
      <div data-id="b" style={{}}></div>
      <div data-id="c" style={{}}></div>
    </div>`;
    const nodes = parseJSXToNodes(code);
    const root = nodes.get('root')!;
    expect(root.children).toHaveLength(3);
    expect(root.children).toEqual(['a', 'b', 'c']);
  });

  test('parses element type correctly', () => {
    const code = `<p data-id="text" style={{}}>Hello</p>`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('text')!.type).toBe('p');
  });

  test('handles empty style object', () => {
    const code = `<div data-id="empty" style={{}}></div>`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('empty')!.styles).toEqual({});
  });

  test('preserves sibling order', () => {
    const code = `<div data-id="root" style={{}}>
      <div data-id="first" style={{}}></div>
      <div data-id="second" style={{}}></div>
      <div data-id="third" style={{}}></div>
    </div>`;
    const nodes = parseJSXToNodes(code);
    const root = nodes.get('root')!;
    expect(root.children[0]).toBe('first');
    expect(root.children[1]).toBe('second');
    expect(root.children[2]).toBe('third');
  });

  test('parses deeply nested structures', () => {
    const code = `<div data-id="l1" style={{}}>
      <div data-id="l2" style={{}}>
        <div data-id="l3" style={{}}>
          <div data-id="l4" style={{}}>
            <p data-id="l5" style={{}}>Deep</p>
          </div>
        </div>
      </div>
    </div>`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.size).toBe(5);
    expect(nodes.get('l5')!.parentId).toBe('l4');
    expect(nodes.get('l4')!.parentId).toBe('l3');
    expect(nodes.get('l1')!.parentId).toBe(null);
  });

  test('parses numeric style values as strings', () => {
    const code = `<div data-id="box" style={{opacity: '0.5', zIndex: '10'}}></div>`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('box')!.styles.opacity).toBe('0.5');
    expect(nodes.get('box')!.styles.zIndex).toBe('10');
  });

  test('parses fragment with viewport root + canvas nodes', () => {
    const code = `<>
  <div data-id="root" style={{width: '1440px'}}></div>
  <div data-id="canvas-frame" data-canvas-node="true" style={{position: 'absolute', left: '1800px', top: '100px'}}></div>
</>`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.has('root')).toBe(true);
    expect(nodes.has('canvas-frame')).toBe(true);
    expect(nodes.get('root')!.isCanvasNode).toBe(false);
    expect(nodes.get('canvas-frame')!.isCanvasNode).toBe(true);
    expect(nodes.get('canvas-frame')!.parentId).toBeNull(); // root-level, not inside anything
  });

  test('non-canvas nodes have isCanvasNode=false', () => {
    const code = `<div data-id="root" style={{}}>
  <div data-id="child" style={{}}></div>
</div>`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('root')!.isCanvasNode).toBe(false);
    expect(nodes.get('child')!.isCanvasNode).toBe(false);
  });

  test('extracts SVG attributes from circle element', () => {
    const code = `<svg data-id="s1" style={{width: '200px', height: '200px'}}>
      <circle data-id="c1" cx="100" cy="100" r="50" fill="#ff0000" stroke="#000" strokeWidth="2" style={{}} />
    </svg>`;
    const nodes = parseJSXToNodes(code);
    const circle = nodes.get('c1')!;
    expect(circle.type).toBe('circle');
    expect(circle.attrs.cx).toBe('100');
    expect(circle.attrs.cy).toBe('100');
    expect(circle.attrs.r).toBe('50');
    expect(circle.attrs.fill).toBe('#ff0000');
    expect(circle.attrs.stroke).toBe('#000');
    expect(circle.attrs.strokeWidth).toBe('2');
  });

  test('extracts SVG attributes from rect element', () => {
    const code = `<svg data-id="s1" style={{}}>
      <rect data-id="r1" x="10" y="20" width="100" height="50" rx="5" fill="blue" style={{}} />
    </svg>`;
    const nodes = parseJSXToNodes(code);
    const rect = nodes.get('r1')!;
    expect(rect.attrs.x).toBe('10');
    expect(rect.attrs.y).toBe('20');
    expect(rect.attrs.width).toBe('100');
    expect(rect.attrs.height).toBe('50');
    expect(rect.attrs.rx).toBe('5');
    expect(rect.attrs.fill).toBe('blue');
  });

  test('extracts SVG path d attribute', () => {
    const code = `<svg data-id="s1" style={{}}>
      <path data-id="p1" d="M10 10 L90 90" fill="none" stroke="black" style={{}} />
    </svg>`;
    const nodes = parseJSXToNodes(code);
    const path = nodes.get('p1')!;
    expect(path.attrs.d).toBe('M10 10 L90 90');
    expect(path.attrs.fill).toBe('none');
    expect(path.attrs.stroke).toBe('black');
  });

  test('extracts SVG attributes with numeric JSX expressions', () => {
    const code = `<svg data-id="s1" style={{}}>
      <circle data-id="c1" cx={50} cy={75} r={25} fill="red" style={{}} />
    </svg>`;
    const nodes = parseJSXToNodes(code);
    const circle = nodes.get('c1')!;
    expect(circle.attrs.cx).toBe('50');
    expect(circle.attrs.cy).toBe('75');
    expect(circle.attrs.r).toBe('25');
  });

  test('extracts viewBox from svg element', () => {
    const code = `<svg data-id="s1" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" style={{width: '200px', height: '200px'}}></svg>`;
    const nodes = parseJSXToNodes(code);
    const svg = nodes.get('s1')!;
    expect(svg.attrs.viewBox).toBe('0 0 200 200');
    expect(svg.attrs.xmlns).toBe('http://www.w3.org/2000/svg');
  });

  test('does not extract SVG attrs from non-SVG elements', () => {
    const code = `<div data-id="d1" cx="100" cy="100" style={{}}></div>`;
    const nodes = parseJSXToNodes(code);
    const div = nodes.get('d1')!;
    expect(div.attrs.cx).toBeUndefined();
    expect(div.attrs.cy).toBeUndefined();
  });

  test('SVG attrs do not overwrite reserved attributes', () => {
    const code = `<svg data-id="s1" style={{width: '100px'}} className="test">
      <rect data-id="r1" style={{opacity: '0.5'}} x="10" fill="red" />
    </svg>`;
    const nodes = parseJSXToNodes(code);
    // className and style should not appear in attrs
    expect(nodes.get('s1')!.attrs.className).toBeUndefined();
    expect(nodes.get('s1')!.attrs.style).toBeUndefined();
    // SVG attrs should be extracted
    expect(nodes.get('r1')!.attrs.x).toBe('10');
    expect(nodes.get('r1')!.attrs.fill).toBe('red');
  });

  test('captures `ref={X}` JSX expressions as attrs.ref = "var:X"', () => {
    // Without capture: paste-engine loses the ref binding entirely and
    // `useScroll({ target: someRef })` throws "Target ref is defined
    // but not hydrated" on the destination page (ref.current stays null
    // because nothing on the JSX attaches it). See effects-roundtrip
    // test for the post-paste rename verification.
    const code = `
import { useRef } from 'react';
export default function Page() {
  const heroRef = useRef(null);
  return (
    <div data-id="root">
      <div ref={heroRef} data-id="hero-1" style={{}} />
    </div>
  );
}
    `;
    const nodes = parseJSXToNodes(code);
    const hero = nodes.get('hero-1');
    expect(hero).toBeDefined();
    expect(hero!.attrs.ref).toBe('var:heroRef');
  });

  test('extracts motionProps (whileHover, whileTap, etc.) on canvas-node elements', () => {
    // Bug: the canvas-nodes parser path (`const canvasNodes = (<>...</>)`)
    // hardcoded `motionProps: null` and skipped the framer-motion prop
    // extraction. A `motion.div whileHover={{ scale: 1.05 }}` dragged
    // onto the canvas had its motion props parsed away, so the
    // Animation tool's `mp?.whileHover` check failed and the hover row
    // never showed up.
    const code = `
import { motion } from 'framer-motion';
export default function Page() {
  return <div data-id="root"></div>;
}
const canvasNodes = (<>
  <motion.div data-id="canvas-hover" data-canvas-node="true" style={{ position: 'absolute' }}
    whileHover={{ scale: 1.05, opacity: 0.8 }}
    whileTap={{ scale: 0.95 }}
  ></motion.div>
</>);
    `;
    const nodes = parseJSXToNodes(code);
    const node = nodes.get('canvas-hover');
    expect(node).toBeDefined();
    expect(node!.motionProps).not.toBeNull();
    expect(node!.motionProps!.whileHover).toEqual({ scale: '1.05', opacity: '0.8' });
    expect(node!.motionProps!.whileTap).toEqual({ scale: '0.95' });
  });

  // RICH TEXT on a canvas node. The canvasNodes walker used to detect
  // `hasMixedContent` but skip the raw inner-JSX slice the main walker does
  // ("preserved walker difference"), leaving `hasMixedContent: true` with an
  // EMPTY textContent. Nothing can paint that — `shouldUseInnerHTML` bails on
  // the empty string, so both build and patch render the element blank. Colour
  // some text inside a canvas node (which wraps it in the single <span> that
  // makes it "mixed") and it vanished from the canvas on every full rebuild,
  // even though the JSX still held it (user report 2026-07-26).
  test('slices rich-text inner JSX into textContent on a canvas node', () => {
    const code = `
export default function Page() {
  return <div data-id="root"></div>;
}
const canvasNodes = (<>
  <div data-id="frame-a" data-canvas-node="true" style={{ position: 'absolute' }}>
    <p data-id="rich-text" data-name="Text" style={{ fontSize: '16px' }}>
      <span style={{ color: 'rgb(255, 255, 255)' }}>Fraud protection, zero liability</span>
    </p>
  </div>
</>);
    `;
    const node = parseJSXToNodes(code).get('rich-text');
    expect(node).toBeDefined();
    expect(node!.hasMixedContent).toBe(true);
    // The raw inner JSX — the renderer feeds this through jsxStyleToHTML.
    expect(node!.textContent).toContain('Fraud protection, zero liability');
    expect(node!.textContent).toContain('<span');
  });

  test('keeps PLAIN canvas-node text as plain text (no markup, not mixed)', () => {
    const code = `
export default function Page() {
  return <div data-id="root"></div>;
}
const canvasNodes = (<>
  <div data-id="frame-b" data-canvas-node="true" style={{ position: 'absolute' }}>
    <p data-id="plain-text" data-name="Text">Just words</p>
  </div>
</>);
    `;
    const node = parseJSXToNodes(code).get('plain-text');
    expect(node!.hasMixedContent).toBeFalsy();
    expect(node!.textContent).toBe('Just words');
  });

  test('does NOT capture ref when it is a string literal (defensive)', () => {
    // `ref="foo"` (string) is not a valid React ref binding anyway, but
    // confirm the parser only treats Identifier expressions as
    // identifier-valued. String-literal `ref` falls through to the
    // existing skip-attrs path.
    const code = `
export default function Page() {
  return (
    <div data-id="root">
      <div ref="foo" data-id="hero-1" style={{}} />
    </div>
  );
}
    `;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('hero-1')!.attrs.ref).toBeUndefined();
  });
});

describe('parseJSXToNodes — variable resolution', () => {
  // The master file's JSX has `style={{ boxShadow: cardShadow }}` (Identifier
  // reference). Without resolution the parser would leave `node.styles.boxShadow`
  // as the literal string `'var:cardShadow'`, which the canvas applies as
  // `el.style.boxShadow = 'var:cardShadow'` — invalid CSS the browser drops.
  // The post-resolve pass replaces that with the function param's default
  // value AND records the binding in `node.styleVariables`.

  test('resolves Identifier style values to their function param defaults', () => {
    const code = `
      export default function Card({ cardShadow = '0 1px 3px rgba(0,0,0,0.1)' }) {
        return <div data-id="root" style={{ boxShadow: cardShadow }}>Hi</div>;
      }
    `;
    const nodes = parseJSXToNodes(code);
    const root = nodes.get('root');
    expect(root).toBeDefined();
    expect(root!.styles.boxShadow).toBe('0 1px 3px rgba(0,0,0,0.1)');
    expect(root!.styleVariables?.boxShadow).toBe('cardShadow');
  });

  test('maps an OVERLAY-var border (::after border: var(--X)) to styleVariables.border', () => {
    // The border variable feeds a `--borda` custom property the ::after consumes. The parser must
    // map `border` → the variable so the Styles tool's Border control shows the bound (purple) state.
    const code = `
      export default function Card({ borda = "1px solid red" }) {
        return (
          <div data-id="root" style={{ position: 'absolute', overflow: 'hidden', "--borda": borda }}>
  <style>{\`
    [data-node-id="root"]::after {
  content: '';
  inset: 0;
  border-radius: inherit;
  border: var(--borda);
    }
  \`}</style>
          </div>
        );
      }
    `;
    const root = parseJSXToNodes(code).get('root');
    expect(root!.styleVariables?.['--borda']).toBe('borda');   // the raw custom-property binding
    expect(root!.styleVariables?.border).toBe('borda');        // mapped through the ::after var
  });

  test('handles backtick-string defaults (TemplateLiteral with no expressions)', () => {
    const code = `
      export default function Card({ cardShadow = \`0 4px 12px rgba(0,0,0,0.2)\` }) {
        return <div data-id="root" style={{ boxShadow: cardShadow }}>Hi</div>;
      }
    `;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('root')!.styles.boxShadow).toBe('0 4px 12px rgba(0,0,0,0.2)');
    expect(nodes.get('root')!.styleVariables?.boxShadow).toBe('cardShadow');
  });

  test('numeric defaults resolve to a string (so the CSS apply path is uniform)', () => {
    const code = `
      export default function Card({ z = 5 }) {
        return <div data-id="root" style={{ zIndex: z }}>Hi</div>;
      }
    `;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('root')!.styles.zIndex).toBe('5');
    expect(nodes.get('root')!.styleVariables?.zIndex).toBe('z');
  });

  test('leaves var:propName intact when no matching prop default exists', () => {
    // Identifier present but no destructured-with-default match — the
    // post-resolve pass leaves the marker so downstream callers can still
    // see something. Better than guessing a value.
    const code = `
      export default function Card() {
        return <div data-id="root" style={{ color: someExternalConst }}>Hi</div>;
      }
    `;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('root')!.styles.color).toBe('var:someExternalConst');
    expect(nodes.get('root')!.styleVariables).toBeUndefined();
  });

  test('arrow function components also get resolved', () => {
    const code = `
      const Card = ({ pad = '12px' }) => <div data-id="root" style={{ padding: pad }} />;
      export default Card;
    `;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('root')!.styles.padding).toBe('12px');
    expect(nodes.get('root')!.styleVariables?.padding).toBe('pad');
  });

  test('URL-wrapped image prop (`backgroundImage: `url(${image})``) → styleVariable + url-wrapped default', () => {
    // The made-component image form: a plain-URL prop wrapped in url(). The master
    // tile resolves to a real `url(...)` value, AND styleVariables records the
    // binding so expandComponent propagates `item.image` per row on the canvas
    // (the ghost re-wraps via formatBoundStyleValue). Renders in editor AND live.
    const code = `
      export default function Card({ image = 'http://x/p.jpg' }) {
        return <div data-id="root" style={{ backgroundImage: \`url(\${image})\` }}>Hi</div>;
      }
    `;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('root')!.styles.backgroundImage).toBe('url(http://x/p.jpg)');
    expect(nodes.get('root')!.styleVariables?.backgroundImage).toBe('image');
  });

  test('resolves {propName} text content to the function param default', () => {
    // The Content control writes `<p>{title}</p>` when the user makes the
    // text a variable. Without resolution the canvas paints empty text,
    // because nothing fills `node.textContent` from a bare Identifier.
    const code = `
      export default function Card({ title = 'Hello World' }) {
        return <p data-id="title-node">{title}</p>;
      }
    `;
    const nodes = parseJSXToNodes(code);
    const n = nodes.get('title-node')!;
    expect(n.textContent).toBe('Hello World');
    expect(n.textVariable).toBe('title');
  });

  test('drops the textVariable marker when there is no matching prop default', () => {
    // Bare {someExternalConst} — not a prop. Don't show the purple bound
    // state for something we can't resolve. Better than lying to the user.
    const code = `
      export default function Card() {
        return <p data-id="x">{someExternalConst}</p>;
      }
    `;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('x')!.textVariable).toBeUndefined();
  });

  test('preserves existing textContent if both literal text and {propName} are present (mixed)', () => {
    // Edge case: `<p>Greeting: {title}</p>` — has both. Don't blow away the
    // literal "Greeting:" by overwriting textContent with the resolved
    // default. Marker stays so the Content control still indicates a binding.
    const code = `
      export default function Card({ title = 'World' }) {
        return <p data-id="x">Greeting: {title}</p>;
      }
    `;
    const nodes = parseJSXToNodes(code);
    // The space before {title} is meaningful (label ↔ value separator) and is
    // now preserved by cleanJsxText — a blanket .trim() used to drop it,
    // rendering "Greeting:World". See jsx-whitespace.ts.
    expect(nodes.get('x')!.textContent).toBe('Greeting: ');
    expect(nodes.get('x')!.textVariable).toBe('title');
  });
});

describe('foreignObject recognition in SVG', () => {
  test('parser recognizes foreignObject elements inside SVG', () => {
    const code = `<svg data-id="fit-svg" style={{width: '100%', height: 'auto'}} viewBox="0 0 520 60">
      <foreignObject data-id="fo1" width="100%" height="100%" style={{overflow: 'visible'}}>
        <p data-id="inner-text" style={{fontSize: '48px'}}>Hello</p>
      </foreignObject>
    </svg>`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.has('fo1')).toBe(true);
    const fo = nodes.get('fo1')!;
    expect(fo.type).toBe('foreignObject');
  });

  test('parser sets correct type for foreignObject nodes', () => {
    const code = `<svg data-id="svg-wrap" style={{}} viewBox="0 0 200 200">
      <foreignObject data-id="fo-node" width="100%" height="100%" style={{}}>
        <div data-id="inner-div" style={{padding: '16px'}}>Content</div>
      </foreignObject>
    </svg>`;
    const nodes = parseJSXToNodes(code);
    const fo = nodes.get('fo-node')!;
    expect(fo.type).toBe('foreignObject');
    // foreignObject should be a child of the SVG
    expect(fo.parentId).toBe('svg-wrap');
    // The inner div should be a child of foreignObject
    const innerDiv = nodes.get('inner-div')!;
    expect(innerDiv.parentId).toBe('fo-node');
    expect(innerDiv.type).toBe('div');
  });

  test('SVG with foreignObject and inner text element parses correctly', () => {
    const code = `<div data-id="root" style={{}}>
      <svg data-id="title-svg" data-name="FIT" xmlns="http://www.w3.org/2000/svg" style={{width: '100%', height: 'auto', overflow: 'visible', display: 'block', whiteSpace: 'pre'}} viewBox="0 0 520 60">
        <foreignObject data-id="title-fo" width="100%" height="100%" style={{overflow: 'visible'}}>
          <h1 data-id="title" style={{fontSize: '64px', fontWeight: '800', margin: '0', lineHeight: '1'}}>Welcome</h1>
        </foreignObject>
      </svg>
    </div>`;
    const nodes = parseJSXToNodes(code);
    // All nodes should be recognized
    expect(nodes.has('root')).toBe(true);
    expect(nodes.has('title-svg')).toBe(true);
    expect(nodes.has('title-fo')).toBe(true);
    expect(nodes.has('title')).toBe(true);
    // Type checks
    expect(nodes.get('title-svg')!.type).toBe('svg');
    expect(nodes.get('title-fo')!.type).toBe('foreignObject');
    expect(nodes.get('title')!.type).toBe('h1');
    // Hierarchy: root > svg > foreignObject > h1
    expect(nodes.get('title-svg')!.parentId).toBe('root');
    expect(nodes.get('title-fo')!.parentId).toBe('title-svg');
    expect(nodes.get('title')!.parentId).toBe('title-fo');
    // Text content
    expect(nodes.get('title')!.textContent).toBe('Welcome');
    // SVG attributes on foreignObject
    const fo = nodes.get('title-fo')!;
    expect(fo.attrs.width).toBe('100%');
    expect(fo.attrs.height).toBe('100%');
    // SVG viewBox
    expect(nodes.get('title-svg')!.attrs.viewBox).toBe('0 0 520 60');
  });

  test('foreignObject without data-id gets auto ID', () => {
    const code = `<svg data-id="s1" style={{}} viewBox="0 0 100 100">
      <foreignObject width="100%" height="100%" style={{}}>
        <p data-id="text" style={{}}>Hello</p>
      </foreignObject>
    </svg>`;
    const nodes = parseJSXToNodes(code);
    // The text element should be parsed
    expect(nodes.has('text')).toBe(true);
    const textNode = nodes.get('text')!;
    // Its parent should be the auto-id'd foreignObject
    expect(textNode.parentId).toBeDefined();
    if (textNode.parentId) {
      const foNode = nodes.get(textNode.parentId);
      expect(foNode).toBeDefined();
      expect(foNode!.type).toBe('foreignObject');
    }
  });
});

describe('CMS collection parsing', () => {
  test('detects import from @/cms/team.json', () => {
    const code = `
import team from '@/cms/team.json';
<div data-id="container" style={{}}>
  {team.map(item => (
    <div data-id="card" style={{}}>{item.name}</div>
  ))}
</div>`;
    const nodes = parseJSXToNodes(code);
    const container = nodes.get('container')!;
    expect(container.collectionList).toBeDefined();
    expect(container.collectionList!.source).toBe('team');
  });

  test('detects .map() pattern on collection variable', () => {
    const code = `
import blogPosts from '@/cms/blog-posts.json';
<div data-id="grid" style={{}}>
  {blogPosts.map(post => (
    <div data-id="post-card" style={{}}>{post.title}</div>
  ))}
</div>`;
    const nodes = parseJSXToNodes(code);
    const grid = nodes.get('grid')!;
    expect(grid.collectionList).toBeDefined();
    expect(grid.collectionList!.source).toBe('blog-posts');
    expect(grid.collectionList!.itemVar).toBe('post');
  });

  test('sets collectionList on parent node with templateIds', () => {
    const code = `
import team from '@/cms/team.json';
<div data-id="list" style={{}}>
  {team.map(member => (
    <div data-id="member-card" style={{}}>
      <p data-id="name" style={{}}>{member.name}</p>
    </div>
  ))}
</div>`;
    const nodes = parseJSXToNodes(code);
    const list = nodes.get('list')!;
    expect(list.collectionList).toBeDefined();
    expect(list.collectionList!.templateIds).toEqual({ default: 'member-card' });
    expect(list.collectionList!.itemVar).toBe('member');
    expect(list.collectionList!.source).toBe('team');
  });

  test('parses a `between` filter as one bounded condition (not two gt/lt)', () => {
    const code = `
import team from '@/cms/team.json';
<div data-id="list" style={{}}>
  {team.filter(item => (item.year >= 2020 && item.year <= 2023)).map(item => (
    <div data-id="card" style={{}}>{item.name}</div>
  ))}
</div>`;
    const list = parseJSXToNodes(code).get('list')!;
    expect(list.collectionList!.filterGroup).toEqual({
      combinator: 'and',
      filters: [{ field: 'year', operator: 'between', value: [2020, 2023] }],
    });
  });

  test('round-trips a `contains` filter emitted as String(item.f).includes(...)', () => {
    const code = `
import team from '@/cms/team.json';
<div data-id="list" style={{}}>
  {team.filter(item => String(item.title).includes("budget")).map(item => (
    <div data-id="card" style={{}}>{item.name}</div>
  ))}
</div>`;
    const fg = parseJSXToNodes(code).get('list')!.collectionList!.filterGroup!;
    expect(fg.filters).toEqual([{ field: 'title', operator: 'contains', value: 'budget' }]);
  });

  test('round-trips the CASE-INSENSITIVE `contains` shape (toLowerCase on both sides)', () => {
    const code = `
import team from '@/cms/team.json';
<div data-id="list" style={{}}>
  {team.filter(item => String(item.title).toLowerCase().includes(String("budget").toLowerCase())).map(item => (
    <div data-id="card" style={{}}>{item.name}</div>
  ))}
</div>`;
    const fg = parseJSXToNodes(code).get('list')!.collectionList!.filterGroup!;
    expect(fg.filters).toEqual([{ field: 'title', operator: 'contains', value: 'budget' }]);
  });

  test('round-trips a date-day filter emitted as String(item.f).slice(0, 10) === "..."', () => {
    const code = `
import blog from '@/cms/blog.json';
<div data-id="list" style={{}}>
  {blog.filter(item => String(item._createdAt).slice(0, 10) === "2026-06-15").map(item => (
    <div data-id="card" style={{}}>{item.title}</div>
  ))}
</div>`;
    const fg = parseJSXToNodes(code).get('list')!.collectionList!.filterGroup!;
    expect(fg.filters).toEqual([{ field: '_createdAt', operator: 'equals', value: '2026-06-15' }]);
  });

  test('round-trips a date-day `between` (sliced LHS on both bounds)', () => {
    const code = `
import blog from '@/cms/blog.json';
<div data-id="list" style={{}}>
  {blog.filter(item => (String(item.date).slice(0, 10) >= "2026-01-01" && String(item.date).slice(0, 10) <= "2026-12-31")).map(item => (
    <div data-id="card" style={{}}>{item.title}</div>
  ))}
</div>`;
    const fg = parseJSXToNodes(code).get('list')!.collectionList!.filterGroup!;
    expect(fg.filters).toEqual([{ field: 'date', operator: 'between', value: ['2026-01-01', '2026-12-31'] }]);
  });

  test('parses a Match-Any (||) filter group', () => {
    const code = `
import team from '@/cms/team.json';
<div data-id="list" style={{}}>
  {team.filter(item => item.role === "Designer" || item.role === "Developer").map(item => (
    <div data-id="card" style={{}}>{item.name}</div>
  ))}
</div>`;
    const fg = parseJSXToNodes(code).get('list')!.collectionList!.filterGroup!;
    expect(fg.combinator).toBe('or');
    expect(fg.filters).toHaveLength(2);
    expect(fg.filters[0]).toEqual({ field: 'role', operator: 'equals', value: 'Designer' });
  });

  test('parses a MULTI-key sort (||-joined 3-branch comparators) in precedence order', () => {
    const code = `
import team from '@/cms/team.json';
<div data-id="list" style={{}}>
  {team.sort((a, b) => (a.year > b.year ? -1 : a.year < b.year ? 1 : 0) || (a.name > b.name ? 1 : a.name < b.name ? -1 : 0)).map(item => (
    <div data-id="card" style={{}}>{item.name}</div>
  ))}
</div>`;
    const sort = parseJSXToNodes(code).get('list')!.collectionList!.sort;
    expect(sort).toEqual([
      { field: 'year', direction: 'desc' },
      { field: 'name', direction: 'asc' },
    ]);
  });

  test('parses a dynamic SEARCH-field filter predicate → valueSource/valueVar', () => {
    const code = `
import team from '@/cms/team.json';
<div data-id="list" style={{}}>
  {team.filter(item => (query === '' || String(item.name).toLowerCase().includes(query.toLowerCase()))).map(item => (
    <div data-id="card" key={idx}>{item.name}</div>
  ))}
</div>`;
    const fg = parseJSXToNodes(code).get('list')!.collectionList!.filterGroup!;
    expect(fg.filters[0]).toEqual({ field: 'name', operator: 'contains', value: '', valueSource: 'searchField', valueVar: 'query' });
  });

  test('parses a dynamic DATE-field filter predicate → valueSource/valueVar', () => {
    const code = `
import team from '@/cms/team.json';
<div data-id="list" style={{}}>
  {team.filter(item => (!fromDate || item.updated >= fromDate)).map(item => (
    <div data-id="card" key={idx}>{item.name}</div>
  ))}
</div>`;
    const fg = parseJSXToNodes(code).get('list')!.collectionList!.filterGroup!;
    expect(fg.filters[0]).toEqual({ field: 'updated', operator: 'gte', value: '', valueSource: 'dateField', valueVar: 'fromDate' });
  });

  test('reads pagination back from the data-pagination marker', () => {
    const code = `
import team from '@/cms/team.json';
<div data-id="list" data-pagination="loadMore:4" style={{}}>
  {team.slice(0, visList).map((item, idx) => (
    <div data-id="card" key={idx}>{item.name}</div>
  ))}
</div>`;
    const pg = parseJSXToNodes(code).get('list')!.collectionList!.pagination!;
    expect(pg.mode).toBe('loadMore');
    expect(pg.perPage).toBe(4);
  });

  test('parses a LEGACY single 2-branch sort into a 1-element array (back-compat)', () => {
    const code = `
import team from '@/cms/team.json';
<div data-id="list" style={{}}>
  {team.sort((a, b) => a.name > b.name ? 1 : -1).map(item => (
    <div data-id="card" style={{}}>{item.name}</div>
  ))}
</div>`;
    const sort = parseJSXToNodes(code).get('list')!.collectionList!.sort;
    expect(sort).toEqual([{ field: 'name', direction: 'asc' }]);
  });

  test('sets isCollectionTemplate on template children', () => {
    const code = `
import team from '@/cms/team.json';
<div data-id="wrapper" style={{}}>
  {team.map(item => (
    <div data-id="card" style={{}}>
      <p data-id="label" style={{}}>{item.name}</p>
      <img data-id="photo" src={item.photo} style={{}} />
    </div>
  ))}
</div>`;
    const nodes = parseJSXToNodes(code);
    // The template root and its children should be flagged
    expect(nodes.get('card')!.isCollectionTemplate).toBe(true);
    expect(nodes.get('label')!.isCollectionTemplate).toBe(true);
    expect(nodes.get('photo')!.isCollectionTemplate).toBe(true);
    // The parent wrapper is NOT inside the .map() callback
    expect(nodes.get('wrapper')!.isCollectionTemplate).toBeUndefined();
  });

  test('detects {item.name} text binding', () => {
    const code = `
import team from '@/cms/team.json';
<div data-id="list" style={{}}>
  {team.map(item => (
    <div data-id="card" style={{}}>
      <p data-id="name-text" style={{}}>{item.name}</p>
    </div>
  ))}
</div>`;
    const nodes = parseJSXToNodes(code);
    const nameText = nodes.get('name-text')!;
    expect(nameText.binding).toBeDefined();
    expect(nameText.binding!.field).toBe('name');
    expect(nameText.binding!.property).toBe('text');
  });

  test('detects src={item.photo} attribute binding', () => {
    const code = `
import team from '@/cms/team.json';
<div data-id="list" style={{}}>
  {team.map(item => (
    <div data-id="card" style={{}}>
      <img data-id="avatar" src={item.photo} style={{}} />
    </div>
  ))}
</div>`;
    const nodes = parseJSXToNodes(code);
    const avatar = nodes.get('avatar')!;
    expect(avatar.binding).toBeDefined();
    expect(avatar.binding!.field).toBe('photo');
    expect(avatar.binding!.property).toBe('src');
  });

  test('detects href={item.link} attribute binding', () => {
    const code = `
import team from '@/cms/team.json';
<div data-id="list" style={{}}>
  {team.map(item => (
    <div data-id="card" style={{}}>
      <a data-id="profile-link" href={item.linkedin} style={{}}>Profile</a>
    </div>
  ))}
</div>`;
    const nodes = parseJSXToNodes(code);
    const link = nodes.get('profile-link')!;
    expect(link.binding).toBeDefined();
    expect(link.binding!.field).toBe('linkedin');
    expect(link.binding!.property).toBe('href');
  });

  test('handles no CMS imports (no false positives)', () => {
    const code = `
<div data-id="root" style={{}}>
  <div data-id="child" style={{}}>Hello</div>
</div>`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('root')!.collectionList).toBeUndefined();
    expect(nodes.get('child')!.isCollectionTemplate).toBeUndefined();
    expect(nodes.get('child')!.binding).toBeUndefined();
  });

  test('handles .map() on primitive array (no false positive)', () => {
    const code = `
const items = [1, 2, 3];
<div data-id="root" style={{}}>
  {items.map(item => (
    <div data-id="item" style={{}}>{item}</div>
  ))}
</div>`;
    const nodes = parseJSXToNodes(code);
    // items is a primitive array (not objects) — should not be flagged
    expect(nodes.get('root')!.collectionList).toBeUndefined();
    expect(nodes.get('item')!.isCollectionTemplate).toBeUndefined();
  });
});

describe('Inline .map() parsing (const array)', () => {
  test('detects const array with object elements', () => {
    const code = `
export default function Page() {
  const faqData = [
    { question: 'How?', answer: 'Like this.' },
    { question: 'Why?', answer: 'Because.' },
  ];
  return (
    <div data-id="root" style={{position: 'relative', width: '100%'}}>
      <div data-id="faq-list" style={{display: 'flex', flexDirection: 'column'}}>
        {faqData.map((item, idx) => (
          <div data-id="faq-item" key={idx} style={{padding: '24px'}}>
            <h3 data-id="faq-q">{item.question}</h3>
            <p data-id="faq-a">{item.answer}</p>
          </div>
        ))}
      </div>
    </div>
  );
}`;
    const nodes = parseJSXToNodes(code);

    // Parent should have collectionList with __inline: prefix
    const faqList = nodes.get('faq-list')!;
    expect(faqList.collectionList).toBeDefined();
    expect(faqList.collectionList!.source).toBe('__inline:faqData');
    expect(faqList.collectionList!.itemVar).toBe('item');
    expect(faqList.collectionList!.templateIds).toEqual({ default: 'faq-item' });

    // Parent should have inlineMapData with the actual data
    expect(faqList.inlineMapData).toBeDefined();
    expect(faqList.inlineMapData).toHaveLength(2);
    expect(faqList.inlineMapData![0]).toEqual({ question: 'How?', answer: 'Like this.' });
    expect(faqList.inlineMapData![1]).toEqual({ question: 'Why?', answer: 'Because.' });
  });

  test('sets isCollectionTemplate on template children', () => {
    const code = `
export default function Page() {
  const items = [
    { title: 'A', desc: 'First' },
    { title: 'B', desc: 'Second' },
  ];
  return (
    <div data-id="wrapper" style={{}}>
      {items.map((item) => (
        <div data-id="card" style={{}}>
          <h2 data-id="card-title">{item.title}</h2>
          <p data-id="card-desc">{item.desc}</p>
        </div>
      ))}
    </div>
  );
}`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('card')!.isCollectionTemplate).toBe(true);
    expect(nodes.get('card-title')!.isCollectionTemplate).toBe(true);
    expect(nodes.get('card-desc')!.isCollectionTemplate).toBe(true);
    // The wrapper is NOT inside the .map() callback
    expect(nodes.get('wrapper')!.isCollectionTemplate).toBeUndefined();
  });

  test('detects text bindings inside inline .map()', () => {
    const code = `
export default function Page() {
  const people = [
    { name: 'Alice', role: 'Dev' },
  ];
  return (
    <div data-id="list" style={{}}>
      {people.map((person) => (
        <div data-id="person-card" style={{}}>
          <p data-id="person-name">{person.name}</p>
          <p data-id="person-role">{person.role}</p>
        </div>
      ))}
    </div>
  );
}`;
    const nodes = parseJSXToNodes(code);
    const nameNode = nodes.get('person-name')!;
    expect(nameNode.binding).toBeDefined();
    expect(nameNode.binding!.field).toBe('name');
    expect(nameNode.binding!.property).toBe('text');

    const roleNode = nodes.get('person-role')!;
    expect(roleNode.binding).toBeDefined();
    expect(roleNode.binding!.field).toBe('role');
    expect(roleNode.binding!.property).toBe('text');
  });

  test('detects attribute bindings inside inline .map()', () => {
    const code = `
export default function Page() {
  const gallery = [
    { src: '/img/a.jpg', link: '/a' },
  ];
  return (
    <div data-id="gallery" style={{}}>
      {gallery.map((item) => (
        <div data-id="gallery-item" style={{}}>
          <img data-id="gallery-img" src={item.src} style={{}} />
          <a data-id="gallery-link" href={item.link} style={{}}>View</a>
        </div>
      ))}
    </div>
  );
}`;
    const nodes = parseJSXToNodes(code);
    const img = nodes.get('gallery-img')!;
    expect(img.binding).toBeDefined();
    expect(img.binding!.field).toBe('src');
    expect(img.binding!.property).toBe('src');

    const link = nodes.get('gallery-link')!;
    expect(link.binding).toBeDefined();
    expect(link.binding!.field).toBe('link');
    expect(link.binding!.property).toBe('href');
  });

  test('handles numeric values in const array objects', () => {
    const code = `
export default function Page() {
  const stats = [
    { label: 'Users', count: 500 },
    { label: 'Revenue', count: 1200 },
  ];
  return (
    <div data-id="stats-list" style={{}}>
      {stats.map((item) => (
        <div data-id="stat-card" style={{}}>{item.label}</div>
      ))}
    </div>
  );
}`;
    const nodes = parseJSXToNodes(code);
    const statsList = nodes.get('stats-list')!;
    expect(statsList.inlineMapData).toBeDefined();
    expect(statsList.inlineMapData![0]).toEqual({ label: 'Users', count: '500' });
    expect(statsList.inlineMapData![1]).toEqual({ label: 'Revenue', count: '1200' });
  });

  test('does not match unknown variables (no false positives)', () => {
    const code = `
export default function Page() {
  return (
    <div data-id="root" style={{}}>
      {unknownVar.map((item) => (
        <div data-id="item" style={{}}>{item.name}</div>
      ))}
    </div>
  );
}`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('root')!.collectionList).toBeUndefined();
    expect(nodes.get('item')!.isCollectionTemplate).toBeUndefined();
    expect(nodes.get('item')!.binding).toBeUndefined();
  });

  test('CMS imports still work alongside inline arrays', () => {
    const code = `
import team from '@/cms/team.json';
export default function Page() {
  const faqData = [
    { question: 'Q1', answer: 'A1' },
  ];
  return (
    <div data-id="root" style={{}}>
      <div data-id="team-list" style={{}}>
        {team.map(member => (
          <div data-id="member-card" style={{}}>{member.name}</div>
        ))}
      </div>
      <div data-id="faq-list" style={{}}>
        {faqData.map(item => (
          <div data-id="faq-card" style={{}}>{item.question}</div>
        ))}
      </div>
    </div>
  );
}`;
    const nodes = parseJSXToNodes(code);

    // CMS import should still work
    const teamList = nodes.get('team-list')!;
    expect(teamList.collectionList).toBeDefined();
    expect(teamList.collectionList!.source).toBe('team');
    expect(teamList.inlineMapData).toBeUndefined();

    // Inline array should also work
    const faqList = nodes.get('faq-list')!;
    expect(faqList.collectionList).toBeDefined();
    expect(faqList.collectionList!.source).toBe('__inline:faqData');
    expect(faqList.inlineMapData).toBeDefined();
    expect(faqList.inlineMapData).toHaveLength(1);
  });

  test('handles top-level const array (not inside export default)', () => {
    const code = `
const features = [
  { title: 'Fast', desc: 'Blazing speed' },
  { title: 'Simple', desc: 'Easy to use' },
];
<div data-id="root" style={{}}>
  {features.map(item => (
    <div data-id="feature" style={{}}>{item.title}</div>
  ))}
</div>`;
    const nodes = parseJSXToNodes(code);
    const root = nodes.get('root')!;
    expect(root.collectionList).toBeDefined();
    expect(root.collectionList!.source).toBe('__inline:features');
    expect(root.inlineMapData).toHaveLength(2);
  });
});

// ─── Map system: styleBindings, text bindings, inlineMapData, isCollectionTemplate ──

describe('Map system — styleBindings in .map() template', () => {
  test('detects single styleBinding (backgroundColor: item.bgColor)', () => {
    const code = `
export default function Page() {
  const cardData = [{"bgColor":"#80aa53"}];
  return (
    <div data-id="root" style={{}}>
      {cardData.map((item, idx) => (
        <div data-id="card" key={idx} style={{backgroundColor: item.bgColor, padding: '16px'}}>
          text
        </div>
      ))}
    </div>
  );
}`;
    const nodes = parseJSXToNodes(code);
    const card = nodes.get('card')!;
    expect(card.styleBindings).toBeDefined();
    expect(card.styleBindings!.length).toBe(1);
    expect(card.styleBindings![0].styleProp).toBe('backgroundColor');
    expect(card.styleBindings![0].field).toBe('bgColor');
  });

  test('detects multiple styleBindings on same element', () => {
    const code = `
export default function Page() {
  const cardData = [{"bg":"red","radius":"8px","pad":"16px"}];
  return (
    <div data-id="root" style={{}}>
      {cardData.map((item, idx) => (
        <div data-id="card" key={idx} style={{background: item.bg, borderRadius: item.radius, padding: item.pad}}>
          text
        </div>
      ))}
    </div>
  );
}`;
    const nodes = parseJSXToNodes(code);
    const card = nodes.get('card')!;
    expect(card.styleBindings).toBeDefined();
    expect(card.styleBindings!.length).toBe(3);
    const bgBinding = card.styleBindings!.find(b => b.styleProp === 'background');
    const radiusBinding = card.styleBindings!.find(b => b.styleProp === 'borderRadius');
    const padBinding = card.styleBindings!.find(b => b.styleProp === 'padding');
    expect(bgBinding!.field).toBe('bg');
    expect(radiusBinding!.field).toBe('radius');
    expect(padBinding!.field).toBe('pad');
  });

  test('does not detect styleBindings for static style values', () => {
    const code = `
export default function Page() {
  const cardData = [{"title":"A"}];
  return (
    <div data-id="root" style={{}}>
      {cardData.map((item, idx) => (
        <div data-id="card" key={idx} style={{backgroundColor: '#ff0000', padding: '16px'}}>
          {item.title}
        </div>
      ))}
    </div>
  );
}`;
    const nodes = parseJSXToNodes(code);
    const card = nodes.get('card')!;
    // No style bindings — all values are static strings
    expect(card.styleBindings).toBeUndefined();
  });

  test('uses correct custom iterator var for styleBindings', () => {
    const code = `
export default function Page() {
  const planData = [{"bg":"blue"}];
  return (
    <div data-id="root" style={{}}>
      {planData.map((plan, idx) => (
        <div data-id="plan" key={idx} style={{background: plan.bg}}>
          text
        </div>
      ))}
    </div>
  );
}`;
    const nodes = parseJSXToNodes(code);
    const plan = nodes.get('plan')!;
    expect(plan.styleBindings).toBeDefined();
    expect(plan.styleBindings!.length).toBe(1);
    expect(plan.styleBindings![0].styleProp).toBe('background');
    expect(plan.styleBindings![0].field).toBe('bg');
  });
});

describe('Map system — text binding in .map() template', () => {
  test('detects {item.title} text binding on child element', () => {
    const code = `
export default function Page() {
  const cardData = [{"title":"Hello","subtitle":"World"}];
  return (
    <div data-id="root" style={{}}>
      {cardData.map((item, idx) => (
        <div data-id="card" key={idx} style={{}}>
          <h3 data-id="card-title" style={{}}>{item.title}</h3>
          <p data-id="card-sub" style={{}}>{item.subtitle}</p>
        </div>
      ))}
    </div>
  );
}`;
    const nodes = parseJSXToNodes(code);
    const titleNode = nodes.get('card-title')!;
    expect(titleNode.binding).toBeDefined();
    expect(titleNode.binding!.field).toBe('title');
    expect(titleNode.binding!.property).toBe('text');

    const subNode = nodes.get('card-sub')!;
    expect(subNode.binding).toBeDefined();
    expect(subNode.binding!.field).toBe('subtitle');
    expect(subNode.binding!.property).toBe('text');
  });

  test('text binding with custom iterator name (plan.name)', () => {
    const code = `
export default function Page() {
  const plans = [{"name":"Free","price":"$0"}];
  return (
    <div data-id="root" style={{}}>
      {plans.map((plan, idx) => (
        <div data-id="plan-card" key={idx} style={{}}>
          <h2 data-id="plan-name" style={{}}>{plan.name}</h2>
          <span data-id="plan-price" style={{}}>{plan.price}</span>
        </div>
      ))}
    </div>
  );
}`;
    const nodes = parseJSXToNodes(code);
    const nameNode = nodes.get('plan-name')!;
    expect(nameNode.binding).toBeDefined();
    expect(nameNode.binding!.field).toBe('name');
    expect(nameNode.binding!.property).toBe('text');

    const priceNode = nodes.get('plan-price')!;
    expect(priceNode.binding).toBeDefined();
    expect(priceNode.binding!.field).toBe('price');
    expect(priceNode.binding!.property).toBe('text');
  });
});

describe('Map system — inlineMapData extraction from const array', () => {
  test('extracts inlineMapData with string fields', () => {
    const code = `
export default function Page() {
  const data = [
    {"name":"Alice","role":"Engineer"},
    {"name":"Bob","role":"Designer"},
  ];
  return (
    <div data-id="root" style={{}}>
      {data.map((item, idx) => (
        <div data-id="person" key={idx} style={{}}>{item.name}</div>
      ))}
    </div>
  );
}`;
    const nodes = parseJSXToNodes(code);
    const root = nodes.get('root')!;
    expect(root.inlineMapData).toBeDefined();
    expect(root.inlineMapData!.length).toBe(2);
    expect(root.inlineMapData![0]).toEqual({ name: 'Alice', role: 'Engineer' });
    expect(root.inlineMapData![1]).toEqual({ name: 'Bob', role: 'Designer' });
  });

  test('extracts inlineMapData with mixed value types (string + number)', () => {
    const code = `
export default function Page() {
  const metrics = [
    { label: 'Users', count: 1500 },
    { label: 'Revenue', count: 50000 },
  ];
  return (
    <div data-id="root" style={{}}>
      {metrics.map((item, idx) => (
        <div data-id="metric" key={idx} style={{}}>{item.label}</div>
      ))}
    </div>
  );
}`;
    const nodes = parseJSXToNodes(code);
    const root = nodes.get('root')!;
    expect(root.inlineMapData).toBeDefined();
    expect(root.inlineMapData!.length).toBe(2);
    // Numeric values should be coerced to strings
    expect(root.inlineMapData![0]).toEqual({ label: 'Users', count: '1500' });
    expect(root.inlineMapData![1]).toEqual({ label: 'Revenue', count: '50000' });
  });

  test('inlineMapData is undefined for non-.map() parents', () => {
    const code = `
export default function Page() {
  return (
    <div data-id="root" style={{}}>
      <div data-id="child" style={{}}>Hello</div>
    </div>
  );
}`;
    const nodes = parseJSXToNodes(code);
    const root = nodes.get('root')!;
    expect(root.inlineMapData).toBeUndefined();
    expect(root.collectionList).toBeUndefined();
  });

  test('inlineMapData only appears on the direct parent of .map(), not grandparent', () => {
    const code = `
export default function Page() {
  const items = [{"label":"A"},{"label":"B"}];
  return (
    <div data-id="root" style={{}}>
      <div data-id="list-wrapper" style={{}}>
        {items.map((item, idx) => (
          <div data-id="list-item" key={idx} style={{}}>{item.label}</div>
        ))}
      </div>
    </div>
  );
}`;
    const nodes = parseJSXToNodes(code);
    // list-wrapper is the direct parent — should have inlineMapData
    const wrapper = nodes.get('list-wrapper')!;
    expect(wrapper.inlineMapData).toBeDefined();
    expect(wrapper.inlineMapData!.length).toBe(2);
    expect(wrapper.collectionList).toBeDefined();
    // root is the grandparent — should NOT have inlineMapData
    const root = nodes.get('root')!;
    expect(root.inlineMapData).toBeUndefined();
    expect(root.collectionList).toBeUndefined();
  });
});

describe('Map system — isCollectionTemplate on children inside .map()', () => {
  test('all descendants inside .map() get isCollectionTemplate=true', () => {
    const code = `
export default function Page() {
  const items = [{"title":"A","desc":"B"}];
  return (
    <div data-id="root" style={{}}>
      {items.map((item, idx) => (
        <div data-id="card" key={idx} style={{}}>
          <div data-id="card-header" style={{}}>
            <h2 data-id="card-title" style={{}}>{item.title}</h2>
          </div>
          <p data-id="card-desc" style={{}}>{item.desc}</p>
        </div>
      ))}
    </div>
  );
}`;
    const nodes = parseJSXToNodes(code);
    // Template root and ALL descendants should be flagged
    expect(nodes.get('card')!.isCollectionTemplate).toBe(true);
    expect(nodes.get('card-header')!.isCollectionTemplate).toBe(true);
    expect(nodes.get('card-title')!.isCollectionTemplate).toBe(true);
    expect(nodes.get('card-desc')!.isCollectionTemplate).toBe(true);
    // Parent outside .map() should NOT be flagged
    expect(nodes.get('root')!.isCollectionTemplate).toBeUndefined();
  });

  test('siblings outside .map() are NOT flagged as isCollectionTemplate', () => {
    const code = `
export default function Page() {
  const items = [{"label":"X"}];
  return (
    <div data-id="root" style={{}}>
      <h1 data-id="heading" style={{}}>Title</h1>
      {items.map((item, idx) => (
        <div data-id="tmpl" key={idx} style={{}}>{item.label}</div>
      ))}
      <footer data-id="footer" style={{}}>Footer</footer>
    </div>
  );
}`;
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('tmpl')!.isCollectionTemplate).toBe(true);
    expect(nodes.get('heading')!.isCollectionTemplate).toBeUndefined();
    expect(nodes.get('footer')!.isCollectionTemplate).toBeUndefined();
    expect(nodes.get('root')!.isCollectionTemplate).toBeUndefined();
  });
});

describe('Map system — collection list dropped on the canvas (canvasNodes)', () => {
  // Regression: a CMS collection list dragged/dropped onto the canvas lives in the
  // `const canvasNodes = <>…</>` fragment. The manual canvasNodes walker only recurses
  // JSXElement children — it skips the `{coll.map(...)}` expression — so it used to
  // clobber the collectionList + children the MAIN traverse had already detected,
  // leaving a collapsed empty box with no ghost rows.
  const code = `'use client';
import Link from 'next/link';
import blog from '@/cms/blog.json';
export default function Page() {
  return <div data-id="root" style={{position:'relative'}}></div>;
}
const canvasNodes = <>
  <div data-id="blogs-cn" data-name="Blogs" data-canvas-node="true" style={{ display: 'flex', position: 'absolute', left: '100px', top: '100px' }}>
    {blog.map((item, idx) =>
    <Link href={\`/blog/\${item?._slug ?? ''}\`} data-id="row-cn" key={idx} style={{ display: 'flex' }} data-name="Blog">
      <div data-id="img-cn" style={{ width: '60px', backgroundImage: \`url(\${item.image})\` }}></div>
      <h3 data-id="title-cn" style={{ fontSize: '18px' }}>{item.title}</h3>
    </Link>
    )}
  </div>
</>;`;

  test('canvas-node collection list keeps its collectionList + template child', () => {
    const nodes = parseJSXToNodes(code);
    const blogs = nodes.get('blogs-cn')!;
    expect(blogs.isCanvasNode).toBe(true);
    expect(blogs.collectionList).toBeDefined();
    expect(blogs.collectionList!.source).toBe('blog');
    expect(blogs.collectionList!.itemVar).toBe('item');
    expect(blogs.collectionList!.templateIds).toEqual({ default: 'row-cn' });
    // Children must NOT be wiped — the template row is linked.
    expect(blogs.children).toEqual(['row-cn']);
  });

  test('the template element keeps its CMS bindings (image style + title text)', () => {
    const nodes = parseJSXToNodes(code);
    expect(nodes.get('row-cn')!.isCollectionTemplate).toBe(true);
    expect(nodes.get('img-cn')!.styleBindings).toEqual([{ styleProp: 'backgroundImage', field: 'image' }]);
    expect(nodes.get('title-cn')!.binding).toEqual({ field: 'title', property: 'text' });
  });

  // Regression: the canvasNodes parser has its OWN (shorter) htmlAttrs list. It was
  // missing `data-search-field` + form attrs, so a Search Field pasted onto the
  // canvas lost its marker → the Input tool showed the full form panel instead of
  // the Variable+Placeholder search panel.
  test('a Search Field input on the canvas keeps data-search-field + form attrs', () => {
    const sfCode = `'use client';
import blog from '@/cms/blog.json';
export default function Page() { return <div data-id="root" />; }
const canvasNodes = <>
  <input data-id="sf-cn" data-name="Search" data-search-field="searchTitle3" type="text" name="q" placeholder="Search..." required style={{ width: '100%' }} />
</>;`;
    const input = parseJSXToNodes(sfCode).get('sf-cn')!;
    expect(input.attrs?.['data-search-field']).toBe('searchTitle3');
    expect(input.attrs?.placeholder).toBe('Search...');
    expect(input.attrs?.name).toBe('q');
  });
});

describe('data-var-orphan (component-variable orphan pills on canvas nodes)', () => {
  // A prop-bound node dragged onto module-scope `canvasNodes` carries
  // `data-var-orphan`; the parser must still surface the purple Content/Style
  // pill (textVariable / styleVariables) — identical to the in-variant node.
  test('canvas-node path reads content + style orphan bindings into pills', () => {
    const code = `
function Card({ style, role = 'Founder & CEO', image = "url('x')" }) {
  return <div data-id="root" style={{ ...style }} />;
}
export default Card;
const canvasNodes = <>
  <p data-id="tc-role" data-canvas-node="true" data-var-orphan="content:role,style.backgroundImage:image" style={{ backgroundImage: "url('x')" }}>{"Founder & CEO"}</p>
</>;
`;
    const node = parseJSXToNodes(code).get('tc-role')!;
    expect(node.textVariable).toBe('role');                       // → purple Content pill
    expect(node.styleVariables?.backgroundImage).toBe('image');   // → purple Fill pill
    expect(node.orphanVarBindings).toEqual([
      { kind: 'content', prop: 'role' },
      { kind: 'style', target: 'backgroundImage', prop: 'image' },
    ]);
  });

  test('main JSX path also reads orphan bindings (non-canvas node)', () => {
    const code = `
function Card({ style, role = 'X' }) {
  return <div data-id="root" style={{ ...style }}>
    <p data-id="tc-role" data-var-orphan="content:role">{"X"}</p>
  </div>;
}
export default Card;
`;
    const node = parseJSXToNodes(code).get('tc-role')!;
    expect(node.textVariable).toBe('role');
  });

  describe('computed data-responsive (per-viewport CMS field rebindings)', () => {
    test('splits literal overrides (→ attrs) from item.field refs (→ responsivePropFieldBindings)', () => {
      const code = `<ProjectsCard data-id="card-1" projectTitle={item.title} data-responsive={JSON.stringify({"768":{"gap":16,"projectTitle":item.shortTitle},"375":{"projectTitle":item.tinyTitle},"_bp":[1440,768,375]})} />`;
      const node = parseJSXToNodes(code).get('card-1')!;
      // Field-refs surfaced as vp → { prop: fieldName }.
      expect(node.responsivePropFieldBindings).toEqual({
        768: { projectTitle: 'shortTitle' },
        375: { projectTitle: 'tinyTitle' },
      });
      // Literal overrides reconstructed into attrs['data-responsive'] (+ _bp) so the
      // existing responsiveProps/variant parsing keeps working.
      const lit = JSON.parse(node.attrs!['data-responsive']);
      expect(lit['768']).toEqual({ gap: 16 });
      expect(lit._bp).toEqual([1440, 768, 375]);
    });

    test('the legacy STRING form still populates attrs and sets no field bindings', () => {
      const code = `<ProjectsCard data-id="card-2" data-responsive='{"768":{"gap":16},"_bp":[1440,768,375]}' />`;
      const node = parseJSXToNodes(code).get('card-2')!;
      expect(node.responsivePropFieldBindings).toBeUndefined();
      expect(JSON.parse(node.attrs!['data-responsive'])['768']).toEqual({ gap: 16 });
    });
  });

  describe('per-variant CMS text binding (raw element in a .map() inside a component master)', () => {
    const wrap = (heading: string) => `
import advisors from '@/cms/advisors.json';
function Frame({ initialVariant = 'default' }) {
  return <div data-id="root">{advisors.map((item, idx) => (
    <div data-id="row" key={idx}><h3 data-id="heading">${heading}</h3></div>
  ))}</div>;
}`;

    test('rebind on variant-1 → variantBindings.text + base binding stays item.role', () => {
      const node = parseJSXToNodes(wrap(`{initialVariant === 'variant-1' ? item.title : item.role}`)).get('heading')!;
      expect(node.binding).toEqual({ field: 'role', property: 'text' });           // base/else
      expect(node.variantBindings!.text!['variant-1']).toEqual({ field: 'title' });  // variant override
    });

    test('unbind→default literal on variant-1 → {value} branch, base item.role', () => {
      const node = parseJSXToNodes(wrap(`{initialVariant === 'variant-1' ? '' : item.role}`)).get('heading')!;
      expect(node.binding).toEqual({ field: 'role', property: 'text' });
      expect(node.variantBindings!.text!['variant-1']).toEqual({ value: '' });
    });

    test('a plain {item.role} (no variant ternary) sets NO variantBindings', () => {
      const node = parseJSXToNodes(wrap(`{item.role}`)).get('heading')!;
      expect(node.binding).toEqual({ field: 'role', property: 'text' });
      expect(node.variantBindings).toBeUndefined();
    });

    test('per-variant STYLE (image) ternary → base styleBinding + variantBindings.style', () => {
      const code = `
import advisors from '@/cms/advisors.json';
function Frame({ initialVariant = 'default' }) {
  return <div data-id="root">{advisors.map((item, idx) => (
    <div data-id="img" key={idx} style={{ backgroundImage: initialVariant === 'variant-1' ? 'none' : \`url(\${item.image})\` }} />
  ))}</div>;
}`;
      const node = parseJSXToNodes(code).get('img')!;
      // Base (else branch) → a normal style binding so the renderer's base path works.
      expect(node.styleBindings).toEqual([{ styleProp: 'backgroundImage', field: 'image' }]);
      // The variant branch (unbind→default 'none') → variantBindings.style.
      expect(node.variantBindings!.style!['variant-1']).toEqual({ backgroundImage: { value: 'none' } });
    });
  });
});
describe('Walker parity — canvasNodes fragment uses the SAME extraction as the main walker', () => {
  // Phase 6.4 root fix: visitCanvasJSXElement calls the shared per-element
  // extraction functions (extractElementAttrs / extractInstanceExpressionProps /
  // extractSvgAttrsInto / extractElementStyles / resolveElement*), so the canvas
  // path can no longer silently drift from the main walker. These tests pin
  // behaviors the old hand-maintained canvas copy DROPPED.

  test('canvas-node component instance keeps numeric/boolean expression props', () => {
    const code = `
export default function Page() {
  return <div data-id="root"></div>;
}

const canvasNodes = (<>
  <Counter data-id="cn-counter" data-canvas-node="true" endValue={500} active={true} label={"Hi"} style={{ position: 'absolute' }} />
</>);`;
    const counter = parseJSXToNodes(code).get('cn-counter')!;
    expect(counter.isCanvasNode).toBe(true);
    // {500} / {true} land in componentProps (were silently dropped before);
    // the {"Hi"} string-literal expression is a plain attr, same as on a page.
    expect(counter.componentProps).toEqual({ endValue: '500', active: 'true' });
    expect(counter.attrs.label).toBe('Hi');
  });

  test('boolean no-value prop on a canvas-node instance parses to "true" (main-walker semantics)', () => {
    const code = `
export default function Page() {
  return <div data-id="root"></div>;
}

const canvasNodes = (<>
  <Image data-id="cn-img" data-canvas-node="true" fill src="/x.png" />
</>);`;
    const img = parseJSXToNodes(code).get('cn-img')!;
    expect(img.attrs.fill).toBe('true');
    expect(img.attrs.src).toBe('/x.png');
  });

  test('same element JSX parses to identical attrs/styles/text on a page and in canvasNodes', () => {
    const elJsx = (id: string) =>
      `<a data-id="${id}" href="/about" target="_blank" rel="noopener" data-smooth-scroll="true" style={{ color: 'red', padding: '4px' }}>Go</a>`;
    const pageCode = `
export default function Page() {
  return <div data-id="root">${elJsx('el-page')}</div>;
}`;
    const canvasCode = `
export default function Page() {
  return <div data-id="root"></div>;
}

const canvasNodes = (<>
  ${elJsx('el-canvas')}
</>);`;
    const pageNode = parseJSXToNodes(pageCode).get('el-page')!;
    const canvasNode = parseJSXToNodes(canvasCode).get('el-canvas')!;
    expect(canvasNode.attrs).toEqual(pageNode.attrs);
    expect(canvasNode.styles).toEqual(pageNode.styles);
    expect(canvasNode.textContent).toBe(pageNode.textContent);
  });
});
