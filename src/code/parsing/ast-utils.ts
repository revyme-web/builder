// ast-utils.ts — Centralized AST traversal helpers for JSX code manipulation.
// Every generator function that searches for a node by data-id uses these.
// Eliminates the 7x duplicated find-by-data-id pattern in generator.ts.

import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import type { JSXElement, JSXAttribute, JSXOpeningElement } from '@babel/types';
import { trace } from '@/shared/debug-trace';

const traverse = (typeof _traverse === 'function' ? _traverse : (_traverse as any).default) as typeof _traverse;

/**
 * Parse JSX code into an AST. Returns null on parse error (user is typing).
 */
export function parseJSX(code: string) {
  try {
    return parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
  } catch {
    trace.error('ast-utils:parse', 'Failed to parse JSX');
    return null;
  }
}

/**
 * Find a JSXElement by its data-id attribute value.
 * This is the most common AST operation — used by every generator function.
 */


/**
 * Find a JSXElement by data-id and stop traversal after finding it.
 * Use this when you only need the first match.
 */
export function findFirstElementByDataId(
  ast: ReturnType<typeof parse>,
  nodeId: string,
  callback: (path: any, element: JSXElement) => void,
): void {
  traverse(ast, {
    JSXElement(path) {
      const opening = path.node.openingElement;
      const idAttr = findAttribute(opening, 'data-id');
      if (idAttr?.value?.type === 'StringLiteral' && idAttr.value.value === nodeId) {
        callback(path, path.node);
        path.stop();
      }
    },
  });
}

/**
 * Find a specific attribute on a JSX opening element.
 */
export function findAttribute(
  opening: JSXOpeningElement,
  attrName: string,
): JSXAttribute | null {
  for (const attr of opening.attributes) {
    if (attr.type === 'JSXAttribute' && attr.name?.name === attrName) {
      return attr;
    }
  }
  return null;
}

/**
 * Get the string value of a JSX attribute (handles both StringLiteral and JSXExpressionContainer).
 */
export function getAttributeValue(attr: JSXAttribute): string | null {
  if (attr.value?.type === 'StringLiteral') return attr.value.value;
  if (attr.value?.type === 'JSXExpressionContainer' && attr.value.expression.type === 'StringLiteral') {
    return attr.value.expression.value;
  }
  return null;
}

// Re-export traverse and parse for convenience
export { traverse, parse };
