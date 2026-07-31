// event-fire-gen.ts — wire a CHILD element inside a component master to FIRE a
// component EVENT variable (a callback prop). The child gets `on<Trigger>={eventVar}`;
// the page instance later passes a handler for that event prop (e.g.
// `childtrigger1={() => setOverlayOpen(true)}`), so the child's interaction fires it.
// Increment B of the standard component-events feature.
//
// PER-VARIANT (variant-agnostic) firing — mirrors the variant-responsive STYLE system
// (setConditionalStyleInCode). A child's handler can fire on ALL variants, on all
// EXCEPT some, or on ONLY some, encoded as a nested ternary keyed off the master's
// variant variable (`variant` | `initialVariant`, via detectVariantVar):
//   base (all):        onClick={eventVar}
//   removed on v2:     onClick={variant === 'v2' ? undefined : eventVar}
//   added only on v2:  onClick={variant === 'v2' ? eventVar : undefined}
// Removing on the PRIMARY ('default') removes the whole binding (every variant);
// removing on a specific variant only blanks that variant's branch.

import { findJSXDataIdIndex, findTagClose } from './generator-utils';
import { detectVariantVar } from './generator-styles';
import { trace } from '@/shared/debug-trace';

export type EventFireTrigger = 'click' | 'mouseEnter' | 'mouseLeave';

const HANDLER: Record<EventFireTrigger, string> = {
  click: 'onClick',
  mouseEnter: 'onMouseEnter',
  mouseLeave: 'onMouseLeave',
};

/** A single branch value: a fire (eventVar + delay) or `null` (no fire → `undefined`). */
type FireVal = { eventVar: string; delay: number } | null;

/** Opening-tag slice [start, '>'] for a node, or null. */
function childTag(code: string, childId: string): { start: number; close: number; tag: string } | null {
  const idIdx = findJSXDataIdIndex(code, childId);
  if (idIdx < 0) return null;
  const start = code.lastIndexOf('<', idIdx);
  const close = findTagClose(code, idIdx); // index of the opening tag's '>'
  if (start < 0 || close < 0) return null;
  return { start, close, tag: code.slice(start, close + 1) };
}

/** Inner expression of `handler={...}` in a tag, or null when the attr is absent.
 *  All our value forms (identifier, `() => setTimeout(...)`, ternary chains) contain
 *  no `}`, so a non-greedy brace match is safe. */
function handlerInner(tag: string, handler: string): string | null {
  const m = tag.match(new RegExp(`${handler}=\\{([^}]*)\\}`));
  return m ? m[1] : null;
}

/** Parse one branch value (`undefined` | `eventVar` | `() => setTimeout(ev, ms)`). */
function parseVal(s: string): FireVal {
  const t = s.trim();
  if (!t || t === 'undefined') return null;
  const def = t.match(/^\(\)\s*=>\s*setTimeout\(\s*(\w+)\s*,\s*(\d+)\s*\)$/);
  if (def) return { eventVar: def[1], delay: parseInt(def[2], 10) / 1000 };
  if (/^\w+$/.test(t)) return { eventVar: t, delay: 0 };
  return null;
}

/** Serialize a branch value back to a JS expression. */
function valToExpr(val: FireVal): string {
  if (!val) return 'undefined';
  return val.delay > 0 ? `() => setTimeout(${val.eventVar}, ${Math.round(val.delay * 1000)})` : val.eventVar;
}

/** Parse a handler inner expression into a `{ variant → FireVal }` map (always has a
 *  `default` key). Accepts the plain forms and the nested per-variant ternary. None of
 *  our branch values contain a top-level `:`, so the first `:` ends each consequent. */
function parseFireExpr(inner: string): Record<string, FireVal> {
  const map: Record<string, FireVal> = {};
  let rest = inner.trim();
  const condRe = /^(?:variant|initialVariant)\s*===\s*'([^']+)'\s*\?\s*/;
  let m: RegExpMatchArray | null;
  while ((m = rest.match(condRe))) {
    rest = rest.slice(m[0].length);
    const colon = rest.indexOf(':');
    if (colon < 0) break;
    map[m[1]] = parseVal(rest.slice(0, colon));
    rest = rest.slice(colon + 1).trim();
  }
  map['default'] = parseVal(rest);
  return map;
}

/** Build the handler inner expression from a `{ variant → FireVal }` map. Returns null
 *  when nothing fires anywhere (caller drops the attribute). Collapses to the plain
 *  `eventVar` form when no variant differs from the default branch. */
function buildFireInner(map: Record<string, FireVal>, variantVar: string): string | null {
  const defExpr = valToExpr(map['default'] ?? null);
  const nonDefault = Object.entries(map)
    .filter(([v]) => v !== 'default')
    .filter(([, val]) => valToExpr(val) !== defExpr); // drop redundant overrides
  if (nonDefault.length === 0) return defExpr === 'undefined' ? null : defExpr;
  const chain = nonDefault.map(([v, val]) => `${variantVar} === '${v}' ? ${valToExpr(val)}`).join(' : ');
  return `${chain} : ${defExpr}`;
}

/** Strip any existing same-trigger handler, then (if `inner` is non-null) insert
 *  `handler={inner}` just before the tag close. */
function writeHandler(tag: string, handler: string, inner: string | null): string {
  const t = tag.replace(new RegExp(`\\s*${handler}=\\{[^}]*\\}`, 'g'), '');
  if (inner === null) return t;
  const selfClose = t.endsWith('/>');
  const insertAt = t.length - (selfClose ? 2 : 1);
  return t.slice(0, insertAt) + ` ${handler}={${inner}}` + t.slice(insertAt);
}

/** Bind a child's `on<Trigger>` to an event variable for `variantName` (default
 *  'default' = the base, all variants). `delay` (seconds): 0 → direct, >0 → deferred
 *  `setTimeout`. Setting on a non-primary variant when there's no base fire makes it
 *  fire ONLY on that variant (a `variant === 'v' ? ev : undefined` ternary). Existing
 *  per-variant branches are preserved. The callback prop is `undefined` until the
 *  instance wires it, so it's a harmless no-op meanwhile. */
export function setChildEventFireInCode(code: string, childId: string, trigger: EventFireTrigger, eventVar: string, delay = 0, variantName = 'default'): string {
  const handler = HANDLER[trigger];
  if (!handler) return code;
  const ct = childTag(code, childId);
  if (!ct) return code;
  const variantVar = detectVariantVar(code);
  const existing = handlerInner(ct.tag, handler);
  const map = existing !== null ? parseFireExpr(existing) : {};
  map[variantName] = { eventVar, delay };
  // Adding on a specific variant with no base → base stays silent (undefined).
  if (variantName !== 'default' && !('default' in map)) map['default'] = null;
  const tag = writeHandler(ct.tag, handler, buildFireInner(map, variantVar));
  trace.action('event-fire:set', { childId, trigger, eventVar, delay, variantName });
  return code.slice(0, ct.start) + tag + code.slice(ct.close + 1);
}

/** Remove a child's `on<Trigger>` event-fire binding. On the PRIMARY ('default') this
 *  removes the whole binding (all variants). On a specific variant it only blanks that
 *  variant's branch (`variant === 'v' ? undefined : ...`), keeping the others; if that
 *  leaves nothing firing anywhere, the attribute is dropped. */
export function removeChildEventFireInCode(code: string, childId: string, trigger: EventFireTrigger, variantName = 'default'): string {
  const handler = HANDLER[trigger];
  if (!handler) return code;
  const ct = childTag(code, childId);
  if (!ct) return code;

  if (variantName === 'default') {
    const tag = writeHandler(ct.tag, handler, null);
    if (tag === ct.tag) return code;
    trace.action('event-fire:remove', { childId, trigger, variantName });
    return code.slice(0, ct.start) + tag + code.slice(ct.close + 1);
  }

  const existing = handlerInner(ct.tag, handler);
  if (existing === null) return code;
  const variantVar = detectVariantVar(code);
  const map = parseFireExpr(existing);
  map[variantName] = null;
  const tag = writeHandler(ct.tag, handler, buildFireInner(map, variantVar));
  trace.action('event-fire:remove', { childId, trigger, variantName });
  return code.slice(0, ct.start) + tag + code.slice(ct.close + 1);
}

/** Read a child's event-fire bindings ACTIVE on `variantName` (default 'default' =
 *  base): `{ trigger, eventVar, delay }` for each `on<Trigger>` whose resolved branch
 *  fires one of `eventVarNames`. A variant whose branch is `undefined` yields no row
 *  for that trigger (so removing on one variant hides it there while keeping others). */
export function parseChildEventFires(code: string, childId: string, eventVarNames: string[], variantName = 'default'): Array<{ trigger: EventFireTrigger; eventVar: string; delay: number }> {
  const ct = childTag(code, childId);
  if (!ct) return [];
  const out: Array<{ trigger: EventFireTrigger; eventVar: string; delay: number }> = [];
  for (const trigger of Object.keys(HANDLER) as EventFireTrigger[]) {
    const inner = handlerInner(ct.tag, HANDLER[trigger]);
    if (inner === null) continue;
    const map = parseFireExpr(inner);
    const val = (variantName in map) ? map[variantName] : (map['default'] ?? null);
    if (val && eventVarNames.includes(val.eventVar)) out.push({ trigger, eventVar: val.eventVar, delay: val.delay });
  }
  return out;
}
