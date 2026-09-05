// Rich per-variant text (Framer parity, 2026-09-05).
//
// The old contract stripped TipTap marks to plain text before the ternary
// write — the user bolded a word on a variant tile, the canvas showed it,
// the file never changed (live find, trace: htmlLen 39 in → plain 15 out →
// noop). These tests pin the new contract end to end: TipTap HTML in →
// JSXFragment branch of real inline runs with OBJECT styles in the file →
// parser reads the branch back as a JSX source slice → the oracle accepts
// the shape (no MISSING_DATA_ID on runs, no STRING_STYLE_ATTR ever).

import { describe, it, expect } from 'vitest';
import { updateVariantTextInCode } from './generator-crud';
import { parseJSXToNodes } from '../parsing/parser';
import { checkFile } from '../oracle/check-file';

const COMPONENT = `/** @name "Frame" */
import React from 'react';
import { motion, LayoutGroup } from 'framer-motion';
const variantConfig = [{ name: 'default', label: 'Frame', isPrimary: true }, { name: 'variant-1', label: 'Frame' }];
function NeJoJi({ style, initialVariant = 'default', ...rest }: any) {
  return <LayoutGroup>
    <motion.div layout={true} data-id="frame-root-1" {...rest} data-name="Frame" style={{ position: 'absolute', width: '579px', ...style }}>
      <motion.p layout={true} data-id="text-child-1" data-name="Text" style={{ fontSize: '16px' }}>{initialVariant === "variant-1" ? "variant words" : "primary words"}</motion.p>
    </motion.div>
  </LayoutGroup>;
}
export default NeJoJi;`;

const TIPTAP = '<span style="font-weight: 700;"><strong>Kako</strong></span> <span style="color: rgb(238, 126, 126);">funkcioniše</span>';

describe('rich per-variant text', () => {
  it('writes a marked variant edit as a JSXFragment branch with OBJECT styles', () => {
    const out = updateVariantTextInCode(COMPONENT, 'text-child-1', 'variant-1', TIPTAP);
    expect(out).not.toContain('style="');                    // never string styles
    expect(out).toContain("fontWeight: '700'");
    expect(out).toContain('rgb(238, 126, 126)');
    expect(out).toContain('funkcioniše');
    expect(out).toContain('"primary words"');                // untouched branch survives
    expect(out).toContain('initialVariant === "variant-1"'); // still the ternary dialect
  });

  it('round-trips: the parser reads the rich branch back as markup', () => {
    const out = updateVariantTextInCode(COMPONENT, 'text-child-1', 'variant-1', TIPTAP);
    const nodes = parseJSXToNodes(out);
    const node = nodes.get('text-child-1')!;
    expect(node).toBeDefined();
    expect(node.conditionalText?.['variant-1']).toContain('<span');
    expect(node.conditionalText?.['variant-1']).toContain('fontWeight');
    expect(node.conditionalText?.['default']).toBe('primary words');
    // The runs are CONTENT, not structure: no auto-id child nodes may be
    // minted for them (live find 2026-09-05: strong/span appeared in the
    // Layers panel, rendered on every tile, and duplicated the text).
    expect(node.children).toHaveLength(0);
    const phantoms = [...nodes.values()].filter((n) => ['strong', 'span'].includes(n.type));
    expect(phantoms).toHaveLength(0);
    // Renderer contract: the rich branch is marked so the tile renders its
    // markup, while the PLAIN default keeps the literal (pasted-source-
    // stays-escaped) contract — richness is an AST fact, never a sniff.
    expect(node.conditionalTextRich?.['variant-1']).toBe(true);
    expect(node.conditionalTextRich?.['default']).toBeUndefined();
    expect(node.textIsLiteral).toBe(true);
  });

  it('a SECOND plain edit on the other variant preserves the rich branch', () => {
    const rich = updateVariantTextInCode(COMPONENT, 'text-child-1', 'variant-1', TIPTAP);
    const out = updateVariantTextInCode(rich, 'text-child-1', 'default', 'new primary');
    expect(out).toContain("fontWeight: '700'");   // rich branch survived the rewrite
    expect(out).toContain('new primary');
  });

  it('editing the primary of a node with RICH CHILDREN no longer strips its marks', () => {
    // Before: creating the first variant branch tag-stripped the primary's
    // spans into a flat fallback literal (silent formatting loss).
    const richPrimary = COMPONENT.replace(
      '{initialVariant === "variant-1" ? "variant words" : "primary words"}',
      `<span style={{ fontWeight: '700' }}>Bold</span> tail`,
    );
    const out = updateVariantTextInCode(richPrimary, 'text-child-1', 'variant-1', 'plain variant');
    expect(out).toContain("fontWeight: '700'");   // primary marks live in the default branch
    expect(out).toContain('plain variant');
  });

  it('collapsing back to a single rich value converges to ordinary children, not a ternary', () => {
    const rich = updateVariantTextInCode(COMPONENT, 'text-child-1', 'variant-1', TIPTAP);
    // Write the SAME rich text to both → branches collapse.
    const collapsed = updateVariantTextInCode(rich, 'text-child-1', 'default',
      rich.includes('initialVariant === "variant-1"')
        ? (parseJSXToNodes(rich).get('text-child-1')!.conditionalText!['variant-1']!)
        : TIPTAP);
    expect(collapsed).not.toContain('initialVariant === "variant-1" ?');
    expect(collapsed).toContain("fontWeight: '700'");
  });

  it('the oracle accepts the rich shape (no MISSING_DATA_ID on runs, no STRING_STYLE_ATTR)', () => {
    const out = updateVariantTextInCode(COMPONENT, 'text-child-1', 'variant-1', TIPTAP);
    const violations = checkFile(out, { kind: 'component', path: 'components/NeJoJi.tsx' });
    const codes = violations.map((v) => v.code);
    expect(codes).not.toContain('STRING_STYLE_ATTR');
    expect(codes).not.toContain('MISSING_DATA_ID');
  });

  it('plain edits keep the historical dialect byte-for-byte (string literal branches)', () => {
    const out = updateVariantTextInCode(COMPONENT, 'text-child-1', 'variant-1', 'just plain words');
    expect(out).toContain('"just plain words"');
    expect(out).not.toContain('<>');
  });
});
