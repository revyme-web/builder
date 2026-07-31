import { describe, it, expect } from 'vitest';
import { parseJSX, findFirstElementByDataId, findAttribute, getAttributeValue } from './ast-utils';

describe('parseJSX', () => {
  it('parses valid JSX', () => {
    const ast = parseJSX('<div data-id="test">hello</div>');
    expect(ast).not.toBeNull();
  });

  it('returns null on invalid JSX', () => {
    const ast = parseJSX('<div data-id="test"');
    expect(ast).toBeNull();
  });
});

describe('findFirstElementByDataId', () => {
  it('finds element by data-id', () => {
    const ast = parseJSX('<div data-id="root"><p data-id="child">text</p></div>');
    expect(ast).not.toBeNull();

    let foundId: string | null = null;
    findFirstElementByDataId(ast!, 'child', (path, element) => {
      const opening = element.openingElement;
      if (opening.name.type === 'JSXIdentifier') {
        foundId = opening.name.name;
      }
    });
    expect(foundId).toBe('p');
  });

  it('stops after first match', () => {
    const ast = parseJSX('<div data-id="root"><p data-id="a">1</p><p data-id="a">2</p></div>');
    expect(ast).not.toBeNull();

    let count = 0;
    findFirstElementByDataId(ast!, 'a', () => { count++; });
    expect(count).toBe(1);
  });

  it('does not call callback when id not found', () => {
    const ast = parseJSX('<div data-id="root">hello</div>');
    expect(ast).not.toBeNull();

    let called = false;
    findFirstElementByDataId(ast!, 'nonexistent', () => { called = true; });
    expect(called).toBe(false);
  });
});

describe('findAttribute', () => {
  it('finds attribute by name', () => {
    const ast = parseJSX('<div data-id="test" data-name="hello"></div>');
    expect(ast).not.toBeNull();

    findFirstElementByDataId(ast!, 'test', (path, element) => {
      const nameAttr = findAttribute(element.openingElement, 'data-name');
      expect(nameAttr).not.toBeNull();
      expect(getAttributeValue(nameAttr!)).toBe('hello');
    });
  });

  it('returns null for missing attribute', () => {
    const ast = parseJSX('<div data-id="test"></div>');
    expect(ast).not.toBeNull();

    findFirstElementByDataId(ast!, 'test', (path, element) => {
      const missing = findAttribute(element.openingElement, 'data-nonexistent');
      expect(missing).toBeNull();
    });
  });
});
