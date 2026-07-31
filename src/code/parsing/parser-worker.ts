// parser-worker.ts — Web Worker that parses JSX in a background thread.
// Main thread posts code string, worker posts back serialized node map.
// This prevents Babel parse from blocking the UI.

import { parse } from '@babel/parser';
import type { JSXElement, JSXText } from '@babel/types';

// We can't import the traverse default export cleanly in a worker, so inline the minimal logic.
// This is a simplified traverse that only visits JSXElements.

interface WorkerNode {
  id: string;
  type: string;
  name: string;
  parentId: string | null;
  children: string[];
  styles: Record<string, string>;
  textContent: string;
  order: number;
}

let idCounter = 0;

function parseJSX(code: string): [string, WorkerNode][] {
  const nodes: [string, WorkerNode][] = [];
  idCounter = 0;

  let ast;
  try {
    ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
  } catch {
    return nodes;
  }

  const parentStack: string[] = [];

  // Manual AST walk (no @babel/traverse dependency in worker)
  function visit(node: any) {
    if (!node || typeof node !== 'object') return;

    if (node.type === 'JSXElement') {
      const el = node as JSXElement;
      const opening = el.openingElement;
      const tagName = opening.name.type === 'JSXIdentifier' ? opening.name.name : 'div';

      let id = getAttr(opening.attributes, 'data-id');
      if (!id) id = `auto_${idCounter++}`;

      const name = getAttr(opening.attributes, 'data-name') || tagName;
      const styles = extractStyles(opening.attributes);

      let textContent = '';
      for (const child of el.children) {
        if (child.type === 'JSXText') {
          const trimmed = (child as JSXText).value.trim();
          if (trimmed) textContent += trimmed;
        }
        if (child.type === 'JSXExpressionContainer' && child.expression.type === 'StringLiteral') {
          textContent += child.expression.value;
        }
      }

      const parentId = parentStack.length > 0 ? parentStack[parentStack.length - 1] : null;

      if (parentId) {
        const parent = nodes.find(([pid]) => pid === parentId);
        if (parent) parent[1].children.push(id);
      }

      const order = parentId ? (nodes.find(([pid]) => pid === parentId)?.[1].children.length ?? 1) - 1 : 0;

      nodes.push([id, { id, type: tagName, name, parentId, children: [], styles, textContent, order }]);

      parentStack.push(id);
      for (const child of el.children) visit(child);
      parentStack.pop();
      return; // don't visit children again
    }

    // Visit all object properties
    for (const key of Object.keys(node)) {
      if (key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
      const val = node[key];
      if (Array.isArray(val)) {
        for (const item of val) visit(item);
      } else if (val && typeof val === 'object' && val.type) {
        visit(val);
      }
    }
  }

  visit(ast);
  return nodes;
}

function getAttr(attrs: any[], name: string): string | null {
  for (const attr of attrs) {
    if (attr.type === 'JSXAttribute' && attr.name?.name === name) {
      if (attr.value?.type === 'StringLiteral') return attr.value.value;
      if (attr.value?.type === 'JSXExpressionContainer' && attr.value.expression.type === 'StringLiteral') {
        return attr.value.expression.value;
      }
    }
  }
  return null;
}

function extractStyles(attrs: any[]): Record<string, string> {
  const styles: Record<string, string> = {};
  for (const attr of attrs) {
    if (attr.type !== 'JSXAttribute' || attr.name?.name !== 'style') continue;
    if (attr.value?.type !== 'JSXExpressionContainer') continue;
    const expr = attr.value.expression;
    if (expr.type !== 'ObjectExpression') continue;
    for (const prop of expr.properties) {
      if (prop.type !== 'ObjectProperty') continue;
      const key = prop.key.type === 'Identifier' ? prop.key.name :
                  prop.key.type === 'StringLiteral' ? prop.key.value : null;
      if (!key) continue;
      let value = '';
      if (prop.value.type === 'StringLiteral') value = prop.value.value;
      else if (prop.value.type === 'NumericLiteral') value = String(prop.value.value);
      else continue;
      styles[key] = value;
    }
  }
  return styles;
}

// ─── Worker message handler ────────────────────────────────────────────────

self.onmessage = (e: MessageEvent<{ code: string; id: number }>) => {
  const { code, id } = e.data;
  const t0 = performance.now();
  const entries = parseJSX(code);
  const duration = performance.now() - t0;

  self.postMessage({ id, entries, duration });
};
