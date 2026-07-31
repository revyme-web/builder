// instance-event-gen.ts — Read AND edit the event-type prop handlers bound on a
// component INSTANCE tag (e.g. `<LoadMore onLoadMore={() => setVisX(...)} />`),
// so the Interactions panel can surface them as interaction rows + edit their
// delay (design-tool parity: a Click interaction with an optional delay).
//
// The binding is first WRITTEN by whoever creates the instance — e.g.
// pagination's `setPaginationInCode` emits `onLoadMore={() => setVisX(...)}` at
// creation time. A non-zero delay wraps the core call in `setTimeout(fn, ms)`:
//   delay 0   → `() => setVisX((c) => c + N)`
//   delay 1.5 → `() => setTimeout(() => setVisX((c) => c + N), 1500)`
// Everything stays plain React, so it's deploy-correct (no canvas-only transform).

import * as t from '@babel/types';
import generate from '@babel/generator';
import { parseJSX, findFirstElementByDataId, findAttribute } from '@/code/parsing/ast-utils';
import { trace } from '@/shared/debug-trace';

export interface InstanceEventBinding {
  /** The event-prop name as declared on the master, e.g. `onLoadMore`. */
  propName: string;
  /** True when the instance passes a handler for this event prop. */
  bound: boolean;
  /** Raw source of the handler expression inside `{…}` (null when unbound). */
  handler: string | null;
  /** Delay before the handler runs, in SECONDS (0 when not wrapped in setTimeout). */
  delay: number;
}

/** Inspect an arrow handler: split out the "core" call text + any setTimeout delay (ms). */
function analyzeArrowHandler(
  arrow: any,
  code: string,
): { coreText: string; delayMs: number } | null {
  if (!arrow || arrow.type !== 'ArrowFunctionExpression') return null;
  const body = arrow.body;
  // `() => setTimeout(<inner>, <ms>)` — a delayed handler.
  if (
    body?.type === 'CallExpression' &&
    body.callee?.type === 'Identifier' &&
    body.callee.name === 'setTimeout' &&
    body.arguments?.length >= 2
  ) {
    const inner = body.arguments[0];
    const delayArg = body.arguments[1];
    const delayMs = delayArg?.type === 'NumericLiteral' ? delayArg.value : 0;
    // inner is the callback: prefer its body (so we keep the bare core call),
    // else fall back to the whole inner expression.
    let coreText: string;
    if (inner?.type === 'ArrowFunctionExpression' && inner.body && typeof inner.body.start === 'number') {
      coreText = code.slice(inner.body.start, inner.body.end);
    } else if (typeof inner?.start === 'number') {
      coreText = code.slice(inner.start, inner.end);
    } else {
      return null;
    }
    return { coreText, delayMs };
  }
  // `() => <core>` — no delay. The body (expression or block) IS the core.
  if (body && typeof body.start === 'number') {
    return { coreText: code.slice(body.start, body.end), delayMs: 0 };
  }
  return null;
}

/**
 * For a component instance (located by its `data-id`), report which of the
 * given event-prop names are bound on the tag, their handler source, and any
 * setTimeout delay (in seconds).
 */
export function parseInstanceEventBindings(
  code: string,
  nodeId: string,
  eventPropNames: string[],
): InstanceEventBinding[] {
  if (!code || !nodeId || eventPropNames.length === 0) return [];

  const ast = parseJSX(code); // returns null on parse failure (logs its own trace)
  if (!ast) {
    trace.error('instance-event-gen:parse-failed', { nodeId });
    return [];
  }

  const result: InstanceEventBinding[] = [];
  findFirstElementByDataId(ast, nodeId, (_path, element) => {
    const opening = element.openingElement;
    for (const name of eventPropNames) {
      const attr = findAttribute(opening, name);
      if (!attr) {
        result.push({ propName: name, bound: false, handler: null, delay: 0 });
        continue;
      }
      let handler: string | null = null;
      let delay = 0;
      const v: any = attr.value;
      // Event handlers are expressions (`{() => …}` / `{ident}`), never string
      // literals — read the raw source span + decode any setTimeout delay.
      if (
        v?.type === 'JSXExpressionContainer' &&
        v.expression &&
        typeof v.expression.start === 'number' &&
        typeof v.expression.end === 'number'
      ) {
        handler = code.slice(v.expression.start, v.expression.end);
        const analyzed = analyzeArrowHandler(v.expression, code);
        if (analyzed) delay = analyzed.delayMs / 1000;
      }
      result.push({ propName: name, bound: !!handler, handler, delay });
    }
  });

  trace.fn('instance-event-gen:parseInstanceEventBindings', {
    nodeId,
    eventPropNames,
    bound: result.filter(r => r.bound).length,
  });
  return result;
}

/**
 * Set the delay (in SECONDS) on a component instance's event-prop handler by
 * wrapping/unwrapping its core call in `setTimeout(fn, ms)`. A no-op when the
 * instance/attribute/arrow isn't found, so callers can fire it blindly.
 */
export function setInstanceEventDelayInCode(
  code: string,
  nodeId: string,
  propName: string,
  delaySeconds: number,
): string {
  const ast = parseJSX(code);
  if (!ast) return code;

  let edit: { start: number; end: number; replacement: string } | null = null;
  findFirstElementByDataId(ast, nodeId, (_path, element) => {
    const attr = findAttribute(element.openingElement, propName);
    const v: any = attr?.value;
    if (!attr || v?.type !== 'JSXExpressionContainer') return;
    const analyzed = analyzeArrowHandler(v.expression, code);
    if (!analyzed) return; // only arrow handlers support delay
    const ms = Math.max(0, Math.round(delaySeconds * 1000));
    const newHandler =
      ms > 0
        ? `() => setTimeout(() => ${analyzed.coreText}, ${ms})`
        : `() => ${analyzed.coreText}`;
    edit = { start: v.start, end: v.end, replacement: `{${newHandler}}` };
  });

  if (!edit) {
    trace.error('instance-event-gen:set-delay-noop', { nodeId, propName, delaySeconds });
    return code;
  }
  const { start, end, replacement } = edit;
  trace.action('instance-event-gen:setInstanceEventDelayInCode', { nodeId, propName, delaySeconds });
  return code.slice(0, start) + replacement + code.slice(end);
}

/**
 * Bind a component-INSTANCE event prop to a "close overlay" handler:
 * `<Instance event1={() => setOverlayXOpen(false)} />`. Adds the attr when
 * absent, replaces its value when present. `setter` = overlayCloseSetter(overlayId).
 * Lets a design component's own event (e.g. an internal X that fires `event1`)
 * close the overlay it lives inside — the page-side counterpart to the plain
 * node "Close Overlay" interaction.
 */
export function setInstanceEventCloseHandlerInCode(
  code: string,
  nodeId: string,
  propName: string,
  setter: string,
): string {
  const ast = parseJSX(code);
  if (!ast) return code;
  let touched = false;
  findFirstElementByDataId(ast, nodeId, (_path: any, element: any) => {
    const opening = element.openingElement;
    // `() => setOverlayXOpen(false)`
    const handler = t.arrowFunctionExpression(
      [],
      t.callExpression(t.identifier(setter), [t.booleanLiteral(false)]),
    );
    const container = t.jsxExpressionContainer(handler);
    const existing = findAttribute(opening, propName) as t.JSXAttribute | null;
    if (existing) existing.value = container;
    else opening.attributes.push(t.jsxAttribute(t.jsxIdentifier(propName), container));
    touched = true;
  });
  if (!touched) return code;
  try {
    trace.action('instance-event-gen:setInstanceEventCloseHandler', { nodeId, propName, setter });
    return generate(ast, { retainLines: true }, code).code;
  } catch (e) {
    trace.error('instance-event-gen:set-close-handler-failed', { nodeId, propName, error: e instanceof Error ? e.message : String(e) });
    return code;
  }
}

/** Remove an event-prop handler attr from a component instance tag (unbind). */
export function removeInstanceEventHandlerInCode(code: string, nodeId: string, propName: string): string {
  const ast = parseJSX(code);
  if (!ast) return code;
  let touched = false;
  findFirstElementByDataId(ast, nodeId, (_path: any, element: any) => {
    const attrs = element.openingElement.attributes;
    const idx = attrs.findIndex((a: any) => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === propName);
    if (idx >= 0) { attrs.splice(idx, 1); touched = true; }
  });
  if (!touched) return code;
  try {
    trace.action('instance-event-gen:removeInstanceEventHandler', { nodeId, propName });
    return generate(ast, { retainLines: true }, code).code;
  } catch {
    return code;
  }
}
