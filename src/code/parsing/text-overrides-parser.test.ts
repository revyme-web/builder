import { describe, test, expect } from 'vitest';
import { parseJSXToNodes } from './parser';

describe('parser: useResponsiveText hook call detection', () => {
  test('plain text element does NOT get textOverrides', () => {
    const code = `export default function Page() {
      return <p data-id="t1">Hello</p>;
    }`;
    const nodes = parseJSXToNodes(code);
    const node = nodes.get('t1');
    expect(node).toBeDefined();
    expect(node!.textContent).toBe('Hello');
    expect(node!.textOverrides).toBeUndefined();
    expect(node!.hasMixedContent).toBe(false);
  });

  test('useResponsiveText call → textContent = primary, textOverrides = width map', () => {
    const code = `export default function Page() {
      return (
        <p data-id="t1">{useResponsiveText('Hello desktop', {
          768: 'Hi tablet',
          375: 'Hi mobile',
        })}</p>
      );
    }`;
    const nodes = parseJSXToNodes(code);
    const node = nodes.get('t1');
    expect(node).toBeDefined();
    expect(node!.textContent).toBe('Hello desktop');
    expect(node!.textOverrides).toEqual({
      '768': 'Hi tablet',
      '375': 'Hi mobile',
    });
    // Should NOT be flagged as mixed content
    expect(node!.hasMixedContent).toBe(false);
  });

  test('useResponsiveText with no overrides arg still parses primary', () => {
    const code = `export default function Page() {
      return <p data-id="t1">{useResponsiveText('Just a primary')}</p>;
    }`;
    const nodes = parseJSXToNodes(code);
    const node = nodes.get('t1');
    expect(node!.textContent).toBe('Just a primary');
    expect(node!.textOverrides).toBeUndefined();
  });

  test('non-useResponsiveText hook call is ignored', () => {
    const code = `export default function Page() {
      return <p data-id="t1">{somethingElse('Hello')}</p>;
    }`;
    const nodes = parseJSXToNodes(code);
    const node = nodes.get('t1');
    // No textContent extracted (the expression isn't our hook).
    // Should fall through to mixed-content / other detection.
    expect(node!.textOverrides).toBeUndefined();
  });
});
