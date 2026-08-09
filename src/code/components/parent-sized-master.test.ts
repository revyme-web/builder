// parent-sized-master.test.ts — Make Component on a node whose size came from
// its PARENT's layout.
//
// User report 2026-08-09: a grid child under `repeat(6, 1fr)` carries no
// `width` key — the cell sizes it. Make Component produced a master whose root
// had no width at all, so the artboard fell back to hugging its content and the
// panel read Width `auto` on a card that is 120px wide on the page.
//
// The Fill case (`flex: '1 0 0px'`, live find 2026-07-08 → master Width 0) was
// the same defect, spotted through a `flex` prop that a grid child simply does
// not have. The rule is not "has a fill flex"; it is "this axis has no key, and
// the artboard has no parent layout to supply one".

import { describe, it, expect } from 'vitest';
import { replaceNonPxDimensions } from './component-ops';

const root = (style: string, tag = 'motion.div') =>
  `<${tag} data-id="client-6" data-name="Client" style={{ ${style} }}>x</${tag}>`;

describe('replaceNonPxDimensions — parent-sized axes', () => {
  it('THE BUG: a grid child with no width key gets the measured px', () => {
    const out = replaceNonPxDimensions(root("position: 'relative', height: '178px'"), 120, 178);
    expect(out).toContain("width: '120px'");
  });

  it('leaves an authored px width alone — the design value, not the measurement', () => {
    const out = replaceNonPxDimensions(root("width: '333px', height: '178px'"), 120, 178);
    expect(out).toContain("width: '333px'");
    expect(out).not.toContain("120px");
  });

  it('still freezes a fluid width, as before', () => {
    expect(replaceNonPxDimensions(root("width: '100%'"), 120, 178)).toContain("width: '120px'");
    expect(replaceNonPxDimensions(root("width: 'auto'"), 120, 178)).toContain("width: '120px'");
  });

  it('injects a missing HEIGHT too', () => {
    const out = replaceNonPxDimensions(root("position: 'relative', width: '120px'"), 120, 178);
    expect(out).toContain("height: '178px'");
  });

  it('the Fill case still works — and still resolves the flex', () => {
    const out = replaceNonPxDimensions(root("flex: '1 0 0px', position: 'relative'"), 120, 178);
    expect(out).toContain("width: '120px'");
    expect(out).toContain("height: '178px'");
    expect(out).toContain("flex: '0 0 auto'");
  });

  it('a TEXT root is never frozen — it must keep growing with its content', () => {
    for (const tag of ['p', 'h2', 'span']) {
      const out = replaceNonPxDimensions(root("position: 'relative'", tag), 120, 40);
      expect(out, tag).not.toContain("width: '120px'");
      expect(out, tag).not.toContain("height: '40px'");
    }
  });

  it('a zero or missing measurement injects nothing rather than a 0px root', () => {
    const out = replaceNonPxDimensions(root("position: 'relative'"), 0, 0);
    expect(out).not.toContain("width: '0px'");
    expect(out).not.toContain("height: '0px'");
  });

  it('never matches a hyphenated or prefixed key as `width`', () => {
    // `maxWidth` / `minWidth` are not the width key — injecting because one of
    // them is present (or absent) would size the root off the wrong value.
    const out = replaceNonPxDimensions(root("maxWidth: '400px', height: '178px'"), 120, 178);
    expect(out).toContain("width: '120px'");
    expect(out).toContain("maxWidth: '400px'");
  });
});
