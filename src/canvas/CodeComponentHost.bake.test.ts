import { describe, it, expect } from 'vitest';
import { extractCodeComponentProps } from './CodeComponentHost';

// An inline-ternary per-viewport variable (`prop={__mq ? var : base}`) on a code-component instance resolves
// its per-tile value into `responsiveAttrPropValues`. The canvas code component reads `data-responsive`, so
// extractCodeComponentProps must bake those resolved values in — otherwise every tile renders the BASE value (the
// bug: a template variable bound on the tablet replica rendered the base color on canvas, while live resolved
// the ternary correctly).
describe('extractCodeComponentProps — bake per-viewport variable values into data-responsive', () => {
  it('bakes responsiveAttrPropValues into data-responsive (preserving _bp)', () => {
    const node: any = {
      id: 'lm',
      attrs: { accentColor: '#FF0606', 'data-responsive': '{"_bp":[375,768,1440]}' },
      responsiveAttrPropValues: { accentColor: { 768: '#A2FF20' } },
    };
    const dr = JSON.parse(extractCodeComponentProps(node)['data-responsive']);
    expect(dr['768'].accentColor).toBe('#A2FF20');
    expect(dr._bp).toEqual([375, 768, 1440]);
  });

  it('does NOT clobber an explicit data-responsive literal already set for that width/prop', () => {
    const node: any = {
      id: 'lm',
      attrs: { 'data-responsive': '{"768":{"accentColor":"#111111"},"_bp":[375,768,1440]}' },
      responsiveAttrPropValues: { accentColor: { 768: '#A2FF20' } },
    };
    const dr = JSON.parse(extractCodeComponentProps(node)['data-responsive']);
    expect(dr['768'].accentColor).toBe('#111111'); // explicit literal wins
  });

  it('no responsiveAttrPropValues → data-responsive untouched', () => {
    const node: any = { id: 'lm', attrs: { accentColor: '#FF0606' } };
    expect(extractCodeComponentProps(node)['data-responsive']).toBeUndefined();
  });
});
