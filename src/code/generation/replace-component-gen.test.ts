import { describe, it, expect } from 'vitest';
import { replaceComponentInstanceInCode } from './replace-component-gen';

describe('replaceComponentInstanceInCode', () => {
  it('swaps a self-closing instance tag, keeps data-id + style, updates data-name', () => {
    const code = `<div><Aura data-id="abc" data-name="Aura" style={{ position: 'absolute', left: '10px', top: '20px', width: '400px', height: '200px' }} /></div>`;
    const out = replaceComponentInstanceInCode(code, { nodeId: 'abc', newTag: 'GradientAura', newDisplayName: 'Gradient Aura' });
    expect(out).toContain('<GradientAura');
    expect(out).not.toContain('<Aura');
    expect(out).toContain('data-id="abc"');
    expect(out).toContain('data-name="Gradient Aura"');
    // style preserved verbatim → width/height intact
    expect(out).toContain("width: '400px'");
    expect(out).toContain("height: '200px'");
    expect(out).toContain("position: 'absolute'");
  });

  it('DROPS the old component-specific props (variant/control/responsive)', () => {
    const code = `<Counter data-id="c1" data-name="Counter" base="#000" speed={3} data-responsive='{"768":{"initialVariant":"v1"}}' style={{ width: '100px' }}></Counter>`;
    const out = replaceComponentInstanceInCode(code, { nodeId: 'c1', newTag: 'FilmGrain', newDisplayName: 'Film Grain' });
    expect(out).toContain('<FilmGrain');
    expect(out).toContain('</FilmGrain>');
    expect(out).not.toContain('base="#000"');
    expect(out).not.toContain('speed={3}');
    expect(out).not.toContain('data-responsive');
    // size kept
    expect(out).toContain("width: '100px'");
  });

  it('keeps data-pinned and a React key', () => {
    const code = `<Card key={item.id} data-id="p1" data-name="Card" data-pinned="true" base="x" style={{ left: '5px' }} />`;
    const out = replaceComponentInstanceInCode(code, { nodeId: 'p1', newTag: 'Hero', newDisplayName: 'Hero' });
    expect(out).toContain('key={item.id}');
    expect(out).toContain('data-pinned="true"');
    expect(out).not.toContain('base="x"');
    expect(out).toContain("left: '5px'");
  });

  it('renames the matching close tag for open+close instances, keeping children', () => {
    const code = `<LensBox data-id="l1" data-name="Lens" style={{ width: '50px' }}><span>slot</span></LensBox>`;
    const out = replaceComponentInstanceInCode(code, { nodeId: 'l1', newTag: 'Carousel', newDisplayName: 'Carousel' });
    expect(out).toContain('<Carousel');
    expect(out).toContain('</Carousel>');
    expect(out).toContain('<span>slot</span>');
    expect(out).not.toContain('LensBox');
  });

  it('is a no-op when the data-id is not found', () => {
    const code = `<Aura data-id="abc" data-name="Aura" />`;
    const out = replaceComponentInstanceInCode(code, { nodeId: 'zzz', newTag: 'X', newDisplayName: 'X' });
    expect(out).toBe(code);
  });

  it('handles an instance with no style attribute', () => {
    const code = `<Aura data-id="abc" data-name="Aura" />`;
    const out = replaceComponentInstanceInCode(code, { nodeId: 'abc', newTag: 'Beta', newDisplayName: 'Beta' });
    expect(out).toContain('<Beta data-id="abc" data-name="Beta" />');
  });
});
