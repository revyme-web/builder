// component-var-detach-gen.test.ts — round-trip detach/rehydrate of component
// variable bindings (content / style / attr) across the canvasNodes boundary.

import { describe, test, expect, vi } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

import {
  dormantizeComponentVarBindings,
  rehydrateComponentVarBindings,
  clearVarOrphanInCode,
  parseVarOrphanBindings,
  isCanvasNode,
  resolveVarOrphansForVariant,
  readTransitionOrphanVar,
} from './component-var-detach-gen';
import { parseJSX } from '../parsing/ast-utils';
import type { CanvasNode } from '../parsing/parser';

const node = (partial: Partial<CanvasNode>): CanvasNode => partial as CanvasNode;

// A component master whose canvasNodes fragment holds nodes that (illegally, at
// module scope) reference the component's props — the exact state right after a
// node is dragged from a variant onto the canvas.
const FILE = `
function Card({ style, bio = 'Default bio', image = "url('x.png')", emailHref = 'mailto:a@b.com', direction = 'row' }) {
  return <div data-id="root" style={{ ...style }} />;
}
export default Card;
const canvasNodes = <>
  <p data-id="tc-bio" style={{ flexDirection: direction }}>{bio}</p>
  <a data-id="tc-link" href={emailHref} style={{ backgroundImage: image }}>link</a>
</>;
`;

describe('parseVarOrphanBindings', () => {
  test('parses content / style / attr entries', () => {
    expect(parseVarOrphanBindings('content:bio,style.backgroundImage:image,attr.href:emailHref')).toEqual([
      { kind: 'content', prop: 'bio' },
      { kind: 'style', target: 'backgroundImage', prop: 'image' },
      { kind: 'attr', target: 'href', prop: 'emailHref' },
    ]);
  });

  test('ignores malformed pairs', () => {
    expect(parseVarOrphanBindings('content:,:bio,bogus,style.x:y')).toEqual([
      { kind: 'style', target: 'x', prop: 'y' },
    ]);
  });
});

describe('transition variable orphan (drag-out of a per-variant transition replica)', () => {
  const TX = `function Comp({ initialVariant = 'default', transition5 = {} }) {
  const [variant] = React.useState(initialVariant);
  return <div><motion.div data-id="r" transition={variant === 'variant-1' ? transition5 : undefined} animate={['default', variant]} data-replica-solo="variant-1" style={{ left: '5px' }}></motion.div></div>;
}`;
  test('stashes the variant-resolved transition var + drops the live ref; reads + rehydrates', () => {
    const out = dormantizeComponentVarBindings(TX, 'r');
    expect(out).toContain('data-var-orphan="transition:transition5"'); // stashed for the solo variant-1
    expect(out).not.toMatch(/transition=\{variant === 'variant-1'/);     // live ref dropped (undefined at module scope)
    expect(readTransitionOrphanVar(out, 'r')).toBe('transition5');        // control reads the pill var
    const back = rehydrateComponentVarBindings(out, 'r');
    expect(back).toMatch(/transition=\{transition5\}/);                   // restored on re-entry
    expect(back).not.toContain('data-var-orphan');                       // stash dropped
  });
  test('a literal transition={{…}} is NOT stashed (no variable)', () => {
    const lit = `function Comp({ x = 1 }) { return <div><motion.div data-id="r" transition={{ type: 'spring' }} style={{ left: '5px' }}></motion.div></div>; }`;
    expect(dormantizeComponentVarBindings(lit, 'r')).not.toContain('transition:');
  });
  test('CLONE path (resolveVarOrphansForVariant) stashes the per-variant transition var from code', () => {
    // The AnimatePresence-wrapped replica drag-out is a clone-detach (new id) — the node model has no transition,
    // so resolveVarOrphansForVariant reads it from the live code for the source variant.
    const code = `function Comp({ initialVariant = 'default', transition1 = {} }) {
  const [variant] = React.useState(initialVariant);
  return <motion.div data-id="q" transition={variant === 'variant-1' ? transition1 : undefined}></motion.div>;
}`;
    expect(resolveVarOrphansForVariant({ id: 'q' } as any, 'variant-1', code)).toContainEqual({ kind: 'transition', prop: 'transition1' });
    // a node with NO own transition ternary (merely inherits MotionConfig) → no transition stash
    expect(resolveVarOrphansForVariant({ id: 'other' } as any, 'variant-1', code).some(e => e.kind === 'transition')).toBe(false);
  });
});

describe('dormantizeComponentVarBindings', () => {
  test('swaps {bio} content + style var for defaults, stashes data-var-orphan', () => {
    const out = dormantizeComponentVarBindings(FILE, 'tc-bio');
    expect(out).toContain('data-var-orphan=');
    expect(out).toContain('content:bio');
    expect(out).toContain('style.flexDirection:direction');
    // Live identifier refs are gone (no crash at module scope). Use the
    // space-separated live form so the check doesn't match the no-space orphan
    // stash (`style.flexDirection:direction`).
    expect(out).not.toContain('{bio}');
    expect(out).not.toContain('flexDirection: direction');
    // Defaults painted in.
    expect(out).toContain('Default bio');
    expect(out).toContain('row');
    expect(() => parseJSX(out)).not.toThrow();
  });

  test('swaps attr var + style var for defaults', () => {
    const out = dormantizeComponentVarBindings(FILE, 'tc-link');
    expect(out).toContain('attr.href:emailHref');
    expect(out).toContain('style.backgroundImage:image');
    expect(out).not.toContain('href={emailHref}');
    expect(out).not.toContain('backgroundImage: image'); // live form (space) — not the orphan stash
    expect(out).toContain('mailto:a@b.com');
    expect(() => parseJSX(out)).not.toThrow();
  });

  test('no-op on a file with no component prop defaults (e.g. a page)', () => {
    const page = `export default function Page() { return <div data-id="x">{bio}</div>; }`;
    expect(dormantizeComponentVarBindings(page, 'x')).toBe(page);
  });

  test('orphans bound DESCENDANTS too (dragging a frame), not just the root', () => {
    // A frame with a bound style on itself + a bound-content child + a bound-style
    // grandchild — dragging the frame out must preserve EVERY variable.
    const code = `
function Card({ style, image = "url('x.png')", role = 'CEO', tint = '#fff' }) {
  return <div data-id="root" style={{ ...style }} />;
}
export default Card;
const canvasNodes = <>
  <div data-id="frame" style={{ backgroundImage: image }}>
    <p data-id="label">{role}</p>
    <span data-id="dot" style={{ color: tint }} />
  </div>
</>;
`;
    const out = dormantizeComponentVarBindings(code, 'frame');
    // Root frame style var, child content var, grandchild style var — all stashed.
    expect(out).toContain('style.backgroundImage:image');
    expect(out).toContain('content:role');
    expect(out).toContain('style.color:tint');
    // No live identifier refs remain anywhere in the subtree.
    expect(out).not.toContain('{role}');
    expect(out).not.toContain('backgroundImage: image');
    expect(out).not.toContain('color: tint');
    expect(() => parseJSX(out)).not.toThrow();
    // Round-trips: rehydrate restores the whole subtree.
    const back = rehydrateComponentVarBindings(out, 'frame');
    expect(back).not.toContain('data-var-orphan');
    expect(back).toContain('{role}');
    expect(back).toMatch(/backgroundImage:\s*image\b/);
    expect(back).toMatch(/color:\s*tint\b/);
  });

  test('no-op when the node references no props', () => {
    const code = `
function Card({ bio = 'x' }) { return <div data-id="root" />; }
export default Card;
const canvasNodes = <><p data-id="plain" style={{ color: 'red' }}>hello</p></>;
`;
    expect(dormantizeComponentVarBindings(code, 'plain')).toBe(code);
  });
});

describe('rehydrateComponentVarBindings', () => {
  test('round-trips: dormantize → rehydrate restores the live bindings', () => {
    const dormant = dormantizeComponentVarBindings(FILE, 'tc-bio');
    const back = rehydrateComponentVarBindings(dormant, 'tc-bio');
    expect(back).not.toContain('data-var-orphan');
    expect(back).toContain('{bio}');
    expect(back).toMatch(/flexDirection:\s*direction/);
    expect(() => parseJSX(back)).not.toThrow();
  });

  test('round-trips attr + style bindings', () => {
    const dormant = dormantizeComponentVarBindings(FILE, 'tc-link');
    const back = rehydrateComponentVarBindings(dormant, 'tc-link');
    expect(back).not.toContain('data-var-orphan');
    expect(back).toMatch(/href=\{emailHref\}/);
    expect(back).toMatch(/backgroundImage:\s*image\b/);
  });

  test('skips a prop that no longer exists, still drops the stash', () => {
    const code = `
function Card({ bio = 'x' }) { return <p data-id="n" data-var-orphan="content:ghost">{"x"}</p>; }
export default Card;
`;
    const out = rehydrateComponentVarBindings(code, 'n');
    expect(out).not.toContain('data-var-orphan'); // stash dropped
    expect(out).not.toContain('{ghost}');          // undefined prop NOT re-introduced
  });

  test('no-op when the node has no stash', () => {
    expect(rehydrateComponentVarBindings(FILE, 'tc-bio')).toBe(FILE);
  });
});

describe('resolveVarOrphansForVariant (replica/variant truth)', () => {
  test('global content + style variables are inherited on any variant', () => {
    const n = node({ textVariable: 'role', styleVariables: { backgroundImage: 'image' } });
    expect(resolveVarOrphansForVariant(n, 'mobile')).toEqual([
      { kind: 'content', prop: 'role' },
      { kind: 'style', target: 'backgroundImage', prop: 'image' },
    ]);
    // page-replica / primary (no variantKey) → still the global binding.
    expect(resolveVarOrphansForVariant(n, undefined)).toEqual([
      { kind: 'content', prop: 'role' },
      { kind: 'style', target: 'backgroundImage', prop: 'image' },
    ]);
  });

  test('per-variant variable branch wins (variable ONLY on this replica)', () => {
    const n = node({ conditionalTextVariable: { mobile: 'role' }, conditionalStyleVariables: { color: { mobile: 'tint' } } });
    expect(resolveVarOrphansForVariant(n, 'mobile')).toEqual([
      { kind: 'content', prop: 'role' },
      { kind: 'style', target: 'color', prop: 'tint' },
    ]);
    // A DIFFERENT variant with no branch + no fallback → nothing.
    expect(resolveVarOrphansForVariant(n, 'desktopX')).toEqual([]);
  });

  test('per-variant LITERAL override removes it here (no attach), even shadowing a global', () => {
    // Realistic ternary form: fallback var in conditional*Variable['default'], the
    // overriding variant in conditional* (literal).
    const content = node({ conditionalTextVariable: { default: 'role' }, conditionalText: { mobile: 'Plain' } });
    expect(resolveVarOrphansForVariant(content, 'mobile')).toEqual([]);            // removed on mobile
    expect(resolveVarOrphansForVariant(content, 'desktop')).toEqual([{ kind: 'content', prop: 'role' }]); // inherited elsewhere

    // Defensive: a global styleVariable shadowed by a per-variant literal even with
    // no conditionalStyleVariables entry.
    const style = node({ styleVariables: { color: 'tint' }, conditionalStyles: { color: { mobile: '#000' } } });
    expect(resolveVarOrphansForVariant(style, 'mobile')).toEqual([]);
    expect(resolveVarOrphansForVariant(style, 'desktop')).toEqual([{ kind: 'style', target: 'color', prop: 'tint' }]);
  });

  test('no variables → empty', () => {
    expect(resolveVarOrphansForVariant(node({}), 'mobile')).toEqual([]);
  });
});

describe('isCanvasNode', () => {
  test('true for a node after `const canvasNodes`, false for one inside the render', () => {
    const code = `
function Card({ style }) { return <div data-id="inside" style={{ ...style }} />; }
export default Card;
const canvasNodes = <><p data-id="oncanvas">x</p></>;
`;
    expect(isCanvasNode(code, 'oncanvas')).toBe(true);
    expect(isCanvasNode(code, 'inside')).toBe(false);
    expect(isCanvasNode(code, 'missing')).toBe(false);
  });

  test('false on a file with no canvasNodes fragment', () => {
    expect(isCanvasNode(`<div data-id="x" />`, 'x')).toBe(false);
  });
});

describe('SET-on-canvas (create-then-dormantize) flow', () => {
  // Simulates the mutation handler: a normal create writes a live `{prop}`, then
  // because the node is a canvas node we dormantize it into the orphan form.
  test('a freshly-bound {name} content on a canvas node becomes the orphan form', () => {
    // What createTextVariableInCode produces: `{name}` child + `name` prop default.
    const afterCreate = `
function Card({ style, name = 'sqdgqsdg' }) { return <div data-id="root" style={{ ...style }} />; }
export default Card;
const canvasNodes = <><p data-id="t">{name}</p></>;
`;
    expect(isCanvasNode(afterCreate, 't')).toBe(true);
    const out = dormantizeComponentVarBindings(afterCreate, 't');
    expect(out).toContain('data-var-orphan="content:name"');
    expect(out).not.toContain('{name}');       // live ref gone → no module-scope crash
    expect(out).toContain('sqdgqsdg');          // default painted
    expect(() => parseJSX(out)).not.toThrow();
  });
});

describe('clearVarOrphanInCode', () => {
  const STASHED = `
function Card({ bio = 'x', direction = 'row' }) { return <div data-id="root" />; }
export default Card;
const canvasNodes = <><p data-id="n" data-var-orphan="content:bio,style.flexDirection:direction" style={{ flexDirection: 'row' }}>{"x"}</p></>;
`;

  test('removes one slot, keeps the rest', () => {
    const out = clearVarOrphanInCode(STASHED, 'n', 'content');
    expect(out).toContain('style.flexDirection:direction');
    expect(out).not.toContain('content:bio');
    expect(() => parseJSX(out)).not.toThrow();
  });

  test('drops the whole attr when the last slot is cleared', () => {
    let out = clearVarOrphanInCode(STASHED, 'n', 'content');
    out = clearVarOrphanInCode(out, 'n', 'style.flexDirection');
    expect(out).not.toContain('data-var-orphan');
  });

  test('clearing content normalizes the {"literal"} child to plain text', () => {
    const code = `
function Card({ role = 'Founder & CEO' }) { return <div data-id="root" />; }
export default Card;
const canvasNodes = <><p data-id="n" data-var-orphan="content:role">{"Founder & CEO"}</p></>;
`;
    const out = clearVarOrphanInCode(code, 'n', 'content');
    expect(out).not.toContain('data-var-orphan');
    expect(out).not.toContain('{"Founder & CEO"}'); // expression gone
    expect(out).toContain('Founder & CEO');          // kept as plain editable text
    expect(() => parseJSX(out)).not.toThrow();
  });

  test('clearing content collapses extra text children (heals duplicate)', () => {
    const code = `
function Card({ role = 'Founder & CEO' }) { return <div data-id="root" />; }
export default Card;
const canvasNodes = <><p data-id="n" data-var-orphan="content:role">{"Founder & CEO"}
      ergergerg
    </p></>;
`;
    const out = clearVarOrphanInCode(code, 'n', 'content');
    expect(out).not.toContain('ergergerg');          // stray duplicate text removed
    expect(out).toContain('Founder & CEO');
    expect(() => parseJSX(out)).not.toThrow();
  });
});
