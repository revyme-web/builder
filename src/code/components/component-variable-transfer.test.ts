import { describe, it, expect } from 'vitest';
import {
  collectTransferableVariables,
  applyVariableTransfer,
  buildInstanceVariableAttrs,
  isReferencedAsValue,
} from './component-variable-transfer';

// The parent template: a `shadow5` Shadow var (simple) + a `transform`/`transform1` per-viewport pair gated by
// `__mq2` + an `order` var that's ONLY a CSS key (must NOT be transferred).
const PARENT = `'use client';
/** @propMeta {"shadow5":{"label":"ergergerg"},"transform":{"type":"transform","label":"transofrm"},"transform1":{"label":"transofrm 2"},"order":{"label":"Order"}} */
/** @pageVariables { "variables": [
  { "name":"shadow5","type":"color","default":"none" },
  { "name":"transform","type":"text","default":"rotate(0deg)" },
  { "name":"transform1","type":"text","default":"rotate(45deg)" },
  { "name":"order","type":"number","default":"2" }
] } */
export default function LayoutClient({ children, shadow5 = "none", transform = "rotate(0deg)", transform1 = "rotate(45deg)", order = "2" }) {
  const __mq2 = useMediaQuery('(max-width: 768px) and (min-width: 376px)');
  return <div data-id="r">{children}</div>;
}`;
const PARENT_PATH = 'app/(Body)/LayoutClient.tsx';

// What buildComponentFile would have produced for the extracted subtree (references shadow5, the per-viewport
// transform ternary, and `order` ONLY as a style key).
const BUILT = `import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

/** @name "Frame" */

const variantConfig = [
  { name: 'default', label: 'Frame', x: 0, y: 0, isPrimary: true },
];
function CoPaDa({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return (
    <LayoutGroup>
    <motion.div layout={true} data-id="f1" {...rest} style={{ boxShadow: shadow5, order: '2', ...style }}>
      <motion.div layout={true} data-id="f2" style={{ transform: __mq2 ? transform1 : transform }} />
    </motion.div>
    </LayoutGroup>
  );
}

export default withResponsiveProps(CoPaDa);
`;

describe('component-variable-transfer', () => {
  it('isReferencedAsValue: value yes, key-only no', () => {
    expect(isReferencedAsValue(BUILT, 'shadow5')).toBe(true);     // boxShadow: shadow5
    expect(isReferencedAsValue(BUILT, 'transform')).toBe(true);   // ternary else-branch
    expect(isReferencedAsValue(BUILT, 'transform1')).toBe(true);  // ternary then-branch
    expect(isReferencedAsValue(BUILT, '__mq2')).toBe(true);       // ternary condition
    expect(isReferencedAsValue(BUILT, 'order')).toBe(false);      // ONLY a CSS key → not a reference
  });

  it('collect: picks referenced vars + the __mq gate, with labels/defaults, drops key-only `order`', () => {
    const { vars, mqs } = collectTransferableVariables(BUILT, PARENT, PARENT_PATH);
    expect(vars.map(v => v.name).sort()).toEqual(['shadow5', 'transform', 'transform1']);
    expect(vars.find(v => v.name === 'shadow5')).toMatchObject({ literal: '"none"', label: 'ergergerg' });
    expect(vars.find(v => v.name === 'transform')).toMatchObject({ metaType: 'transform', label: 'transofrm' });
    expect(mqs).toEqual([{ id: '__mq2', query: '(max-width: 768px) and (min-width: 376px)' }]);
  });

  it('apply: adds params, @propMeta, the __mq hook + useMediaQuery — no undefined identifiers left', () => {
    const { vars, mqs } = collectTransferableVariables(BUILT, PARENT, PARENT_PATH);
    const out = applyVariableTransfer(BUILT, 'CoPaDa', vars, mqs);
    // params injected before ...rest
    expect(out).toMatch(/initialVariant = 'default', shadow5 = "none", transform = "rotate\(0deg\)", transform1 = "rotate\(45deg\)", \.\.\.rest/);
    // @propMeta carries labels + the transform type
    expect(out).toContain('@propMeta');
    expect(out).toMatch(/"shadow5":\{"label":"ergergerg"\}/);
    expect(out).toMatch(/"transform":\{"type":"transform","label":"transofrm"\}/);
    // __mq hook + useMediaQuery fn present
    expect(out).toContain("const __mq2 = useMediaQuery('(max-width: 768px) and (min-width: 376px)');");
    expect(out).toContain('function useMediaQuery(query: string)');
    // every previously-undefined identifier is now declared (param or hook)
    for (const id of ['shadow5', 'transform', 'transform1', '__mq2']) expect(out.includes(id)).toBe(true);
  });

  it('instance attrs pass each var through from the parent (auto-hoist)', () => {
    const { vars } = collectTransferableVariables(BUILT, PARENT, PARENT_PATH);
    expect(buildInstanceVariableAttrs(vars)).toBe(' shadow5={shadow5} transform={transform} transform1={transform1}');
  });

  // 100% of variable TYPES (color/border/number/boolean/image) + a PER-REPLICA variant pair gated by __mq.
  it('ALL variable types + per-replica variant transfer (number/boolean stay raw, strings quoted)', () => {
    const parent = `'use client';
/** @propMeta {"fillVar":{"label":"Fill"},"borderVar":{"type":"border","label":"Border"},"numVar":{"type":"number","label":"Num"},"boolVar":{"type":"toggle","label":"Bool"},"imgVar":{"label":"Img"},"variantA":{"label":"VarA"},"variantB":{"label":"VarB"}} */
export default function L({ children, fillVar = "#ff0000", borderVar = "1px solid #000", numVar = 0.8, boolVar = false, imgVar = "https://x/y.png", variantA = "default", variantB = "hover" }) {
  const __mq1 = useMediaQuery('(max-width: 375px)');
  return <div>{children}</div>;
}`;
    const built = `/** @name "C" */
function CC({ style, initialVariant = 'default', ...rest }: { style?: any; initialVariant?: string; [key: string]: any }) {
  return (<div {...rest} style={{ backgroundColor: fillVar, border: borderVar, opacity: numVar, display: boolVar ? 'none' : '', backgroundImage: imgVar, ...style }}>
    <Btn initialVariant={__mq1 ? variantB : variantA} />
  </div>);
}`;
    const { vars, mqs } = collectTransferableVariables(built, parent, 'app/(Body)/L.tsx');
    const out = applyVariableTransfer(built, 'CC', vars, mqs);
    expect(vars.find(v => v.name === 'numVar')?.literal).toBe('0.8');         // number → raw
    expect(vars.find(v => v.name === 'boolVar')?.literal).toBe('false');      // boolean → raw
    expect(vars.find(v => v.name === 'fillVar')?.literal).toBe('"#ff0000"');  // string → quoted
    expect(mqs.map(m => m.id)).toEqual(['__mq1']);                            // per-replica gate transferred
    // every referenced identifier (incl. the per-viewport variant pair) is declared as a param or hook
    for (const id of ['fillVar', 'borderVar', 'numVar', 'boolVar', 'imgVar', 'variantA', 'variantB', '__mq1']) {
      expect(new RegExp(`(?<![\\w$])${id}\\s*=`).test(out)).toBe(true);
    }
  });
});

// ─── Event props ───────────────────────────────────────────────────────────
// The reported bug: a node carrying `onClick={event1}` was extracted into a new
// component, but `event1` is declared on the parent WITHOUT a default (a callback
// has nothing to default to), so the "required prop, not a variable" gate skipped
// it. The component referenced an identifier it never declared and the instance
// passed nothing — ReferenceError at render, interaction silently lost.
//
// Mirrors the Header/HuPoPo case: `event1` is an event prop, `content` is an
// ordinary defaulted prop, and only `event1` is referenced by the extracted node.
const EVENT_PARENT = `'use client';
/** @propMeta {"event1":{"type":"event","label":"Modal"},"content":{"type":"plainText","label":"Copy"}} */
export default function Header({ style, initialVariant = 'default', event1, content = "AI Intelligence" }) {
  return <div data-id="r" />;
}`;
const EVENT_PARENT_PATH = 'components/Header.tsx';

const EVENT_BUILT = `import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';

/** @name "Find Advisor" */

function HuPoPo({ style, initialVariant = 'default', ...rest }: { style?: React.CSSProperties; initialVariant?: string; [key: string]: any }) {
  return (
    <LayoutGroup>
    <MotionLink data-id="find-btn" onClick={event1}>Find an advisor</MotionLink>
    </LayoutGroup>
  );
}

export default withResponsiveProps(HuPoPo);`;

describe('event props transfer', () => {
  it('collects an event prop even though it has no default', () => {
    const { vars } = collectTransferableVariables(EVENT_BUILT, EVENT_PARENT, EVENT_PARENT_PATH);
    const names = vars.map(v => v.name);
    expect(names).toContain('event1');
    // `content` is defaulted but NOT referenced by the extracted subtree.
    expect(names).not.toContain('content');
  });

  it('renames it on the CHILD after the trigger, not the parent meaning', () => {
    // The child publishes "I was clicked"; only the parent knows that means Modal.
    const { vars } = collectTransferableVariables(EVENT_BUILT, EVENT_PARENT, EVENT_PARENT_PATH);
    const ev = vars.find(v => v.name === 'event1')!;
    expect(ev.metaType).toBe('event');
    expect(ev.childName).toBe('click');
    expect(ev.label).toBe('Click');
    expect(ev.literal).toBeNull();
  });

  it('keeps the parent name when the var is NOT purely a handler', () => {
    // Also forwarded into a nested instance → no single trigger to name it after,
    // and renaming would silently repoint that other usage.
    const mixed = EVENT_BUILT.replace('<MotionLink data-id="find-btn"', '<Inner someProp={event1} /><MotionLink data-id="find-btn"');
    const { vars } = collectTransferableVariables(mixed, EVENT_PARENT, EVENT_PARENT_PATH);
    const ev = vars.find(v => v.name === 'event1');
    expect(ev?.childName).toBeUndefined();
  });

  it('emits the param BARE under the child name, and repoints the handler', () => {
    const { vars } = collectTransferableVariables(EVENT_BUILT, EVENT_PARENT, EVENT_PARENT_PATH);
    const out = applyVariableTransfer(EVENT_BUILT, 'HuPoPo', vars, []);
    expect(out).toContain("initialVariant = 'default', click, ...rest");
    expect(out).toContain('onClick={click}');
    // The parent's identifier must not survive inside the child — that was the crash.
    expect(out).not.toContain('onClick={event1}');
    expect(out).not.toMatch(/click\s*=\s*['"]/);
    expect(out).toMatch(/@propMeta[^*]*"click":\{"type":"event","label":"Click"\}/);
  });

  it('the instance wires childProp={parentEvent} — behaviour preserved', () => {
    const { vars } = collectTransferableVariables(EVENT_BUILT, EVENT_PARENT, EVENT_PARENT_PATH);
    expect(buildInstanceVariableAttrs(vars)).toContain('click={event1}');
  });

  it('an event prop the subtree does NOT reference is not transferred', () => {
    const noRef = EVENT_BUILT.replace('onClick={event1}', '');
    const { vars } = collectTransferableVariables(noRef, EVENT_PARENT, EVENT_PARENT_PATH);
    expect(vars.map(v => v.name)).not.toContain('event1');
  });

  it('ordinary defaulted props still transfer WITH their literal', () => {
    const built = EVENT_BUILT.replace('>Find an advisor<', '>{content}<');
    const { vars } = collectTransferableVariables(built, EVENT_PARENT, EVENT_PARENT_PATH);
    const c = vars.find(v => v.name === 'content')!;
    expect(c.literal).toBe('"AI Intelligence"');
    const out = applyVariableTransfer(built, 'HuPoPo', vars, []);
    expect(out).toContain('content = "AI Intelligence"');
  });
});
