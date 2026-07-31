import { describe, it, expect } from 'vitest';
import { resolveMediaGateTernariesInCode } from './generator-crud';

// When a node with per-viewport link/bool-nav variables is dragged OUT to module-scope `canvasNodes`, its
// `__mqN` gate ternaries reference `useMediaQuery` consts that only exist inside the component fn → the
// validator blocks the move ("References undefined identifiers: __mq2, __mq1"). This collapses them to base.
describe('resolveMediaGateTernariesInCode', () => {
  const wrap = (tag: string) => `const x = <div>${tag}</div>;`;

  it('collapses an href __mq ternary + a bool-nav INNER __mq, leaving NO __mq ref but KEEPING the base var', () => {
    const code = wrap(`<MotionLink data-id="p-24" data-name="Line 1" href={__mq2 ? "/a" : __mq1 ? "/b" : "/c"} target={(__mq2 ? false : openInNewTab2) ? "_blank" : undefined}>{"X"}</MotionLink>`);
    const out = resolveMediaGateTernariesInCode(code, 'p-24');
    expect(/__mq/.test(out)).toBe(false);                                  // no out-of-scope gate refs
    expect(out).toMatch(/href=\{?"\/c"\}?/);                               // href → final base branch
    expect(out).toMatch(/target=\{openInNewTab2 \? "_blank" : undefined\}/); // bool-nav var preserved for the orphan pass
  });

  it('only touches the targeted node + is a no-op when there is no __mq gate', () => {
    const code = wrap(`<a data-id="keep" href={__mq2 ? "x" : "y"} /><a data-id="me" href={__mq1 ? "p" : "q"} />`);
    const out = resolveMediaGateTernariesInCode(code, 'me');
    expect(out).toMatch(/data-id="keep" href=\{__mq2 \? "x" : "y"\}/);     // other node untouched
    expect(out).toMatch(/data-id="me" href=\{?"q"\}?/);                    // target node collapsed
    expect(resolveMediaGateTernariesInCode(wrap(`<a data-id="me" href="/plain" />`), 'me')).toBe(wrap(`<a data-id="me" href="/plain" />`));
  });
});
