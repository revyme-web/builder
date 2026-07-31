import { describe, it, expect } from 'vitest';
import { setInlineVariableForVariant, removeVariantStyleVariableInCode } from './variable-ops';
import { updateVariantStyleInCode } from '../generation/generator-styles';
import { parseJSXToNodes } from '../parsing/parser';

// Phase 1: creating a variable on a NON-default component variant for a prop the BASE already binds
// must mint a VARIANT-SCOPED override (`<cssProp>: initialVariant === 'v' ? newVar : baseVar`), keeping
// the base's own variable via the ternary else — NOT reuse/overwrite the base binding.
const comp = (baseExpr: string) => `'use client';
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
const variantConfig = [{ name:'default', isPrimary:true },{ name:'variant-1' }];
function C({ style, initialVariant = 'default', baseJ = "center", variantJ = "flex-end", ...rest }) {
  return <LayoutGroup><motion.div data-id="n1" data-name="N" animate={['default', initialVariant]} style={{ position:'relative', justifyContent: ${baseExpr} }}></motion.div></LayoutGroup>;
}
export default withResponsiveProps(C);`;

describe('per-variant variable override (identifier-else)', () => {
  it('codegen writes `? variantVar : baseVar` with the base as a bare identifier', () => {
    const out = setInlineVariableForVariant(comp('baseJ'), 'n1', 'justifyContent', 'variant-1', 'variantJ', 'baseJ', 'flex-end', true);
    expect(out).toMatch(/justifyContent:\s*initialVariant === ["']variant-1["'] \? variantJ : baseJ/);
    expect(out).not.toMatch(/:\s*["']baseJ["']/); // base is the IDENTIFIER, not a quoted string
  });

  it('legacy literal-else still quotes the base (elseIsIdentifier=false)', () => {
    const out = setInlineVariableForVariant(comp('"center"'), 'n1', 'justifyContent', 'variant-1', 'variantJ', 'center', 'flex-end', false);
    expect(out).toMatch(/justifyContent:\s*initialVariant === ["']variant-1["'] \? variantJ : ["']center["']/);
  });

  it('parser reads the variant override into conditionalStyleVariables AND the base into styleVariables', () => {
    const out = setInlineVariableForVariant(comp('baseJ'), 'n1', 'justifyContent', 'variant-1', 'variantJ', 'baseJ', 'flex-end', true);
    const node = parseJSXToNodes(out).get('n1')!;
    expect(node.conditionalStyleVariables?.justifyContent?.['variant-1']).toBe('variantJ');
    expect(node.styleVariables?.justifyContent).toBe('baseJ');           // base binding kept (not lost)
    expect(node.styles.justifyContent).toBe('center');                   // base value painted on primary
    expect(node.conditionalStyles?.justifyContent?.['variant-1']).toBe('flex-end'); // variant value painted
  });

  it('removeVariantStyleVariableInCode drops the variant branch → bare base (codegen unit)', () => {
    let out = setInlineVariableForVariant(comp('baseJ'), 'n1', 'justifyContent', 'variant-1', 'variantJ', 'baseJ', 'flex-end', true);
    out = removeVariantStyleVariableInCode(out, 'n1', 'justifyContent', 'variant-1');
    expect(out).toMatch(/justifyContent:\s*baseJ\b/);                    // reverted to bare base var
    expect(out).not.toMatch(/initialVariant === ["']variant-1["']/);     // ternary branch gone
    const node = parseJSXToNodes(out).get('n1')!;
    expect(node.styleVariables?.justifyContent).toBe('baseJ');           // base binding kept
    expect(node.conditionalStyleVariables?.justifyContent).toBeFalsy();  // no per-variant override left
  });

  it('REMOVE on a replica DETACHES to a literal (no variable) — base keeps its variable, pill clears', () => {
    // The full ControlProvider flow: drop the inline branch + write the variant-object LITERAL.
    let out = setInlineVariableForVariant(comp('baseJ'), 'n1', 'justifyContent', 'variant-1', 'variantJ', 'baseJ', 'flex-end', true);
    out = removeVariantStyleVariableInCode(out, 'n1', 'justifyContent', 'variant-1');
    out = updateVariantStyleInCode(out, 'n1', 'variant-1', { justifyContent: 'flex-end' });
    const node = parseJSXToNodes(out).get('n1')!;
    expect(node.styleVariables?.justifyContent).toBe('baseJ');           // base KEEPS its variable
    expect(node.conditionalStyleVariables?.justifyContent).toBeFalsy();  // replica has NO variable (pill gone)
    expect((node.motionVariants as any)?.['variant-1']?.justifyContent).toBe('flex-end'); // active literal override
  });
});
