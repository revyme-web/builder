// ticker-gen.ts — the Ticker effect on a layout frame (Framer's Ticker effect:
// an infinite marquee of the frame's own children).
//
// Source shape (runtime `RevymeTicker`, see runtime/src/ticker.tsx):
//
//   import { RevymeTicker } from '@revyme/runtime';
//   …
//   <RevymeTicker speed={80} direction="left" hoverSpeed={0.5} draggable fade={48}>
//     <motion.div data-id="logos" style={{ display: 'flex', gap: '24px', … }}>
//       …the items, plain children of the frame…
//     </motion.div>
//   </RevymeTicker>
//
// The wrapper sits DIRECTLY around the frame. The parser looks through it
// (node.ticker), the canvas draws the frame still, and the mutation queue
// lifts / restores it around every other mutation (element-wrapper.ts), so no
// generator needs to know about it. A frame that also has a code override
// keeps the ticker OUTSIDE: `<RevymeTicker><Override …><div/></Override></RevymeTicker>`
// (the queue lifts overrides first and restores them last).

import { trace } from '@/shared/debug-trace';
import {
  TICKER_DEFAULTS, normalizeTicker, tickerFromJsxAttributes, tickerNeedsVariant,
  type TickerConfig, type TickerOverride,
} from '@/shared/ticker-config';
import { parseJSX } from '@/code/parsing/ast-utils';
import { findSubtreeRange } from './generator-utils';
import { liftElementWrappers, restoreElementWrappers, ensureRuntimeWrapperImport, type LiftedWrappers } from './element-wrapper';
import { liftCodeOverrides, restoreCodeOverrides } from './code-override-gen';

export { TICKER_DEFAULTS, normalizeTicker, type TickerConfig, type TickerDirection } from '@/shared/ticker-config';

export const TICKER_TAG = 'RevymeTicker';

/**
 * `<RevymeTicker …>` for a config. Speed and direction are always written
 * (the two a reader looks for); the rest only when not the default.
 *
 * Per-breakpoint / per-variant overrides go in ONE `responsive` literal, the
 * same shape as RevymeSplitText's: `responsive={[{ scope: { query: "…" },
 * speed: 120 }]}`. The query is written with double quotes so the breakpoint
 * resize pass (rewriteAnimationBreakpoints) re-stamps it with the viewport.
 * `{ variant }` scopes read the component's active variant through the
 * `variant` prop — `variantVar` names it (`variant` or `initialVariant`).
 */
export function tickerOpenTag(config: TickerConfig, variantVar = 'variant'): string {
  const c = normalizeTicker(config);
  const attrs = [`speed={${round(c.speed)}}`, `direction="${c.direction}"`];
  if (c.hoverSpeed !== TICKER_DEFAULTS.hoverSpeed) attrs.push(`hoverSpeed={${round(c.hoverSpeed)}}`);
  if (c.draggable) attrs.push('draggable');
  if (c.fade > 0) attrs.push(`fade={${round(c.fade)}}`);
  if (c.disabled) attrs.push('disabled');
  if (c.responsive?.length) attrs.push(`responsive={[${c.responsive.map(overrideSource).join(', ')}]}`);
  if (tickerNeedsVariant(c)) attrs.push(`variant={${variantVar}}`);
  return `<${TICKER_TAG} ${attrs.join(' ')}>`;
}

function overrideSource(r: TickerOverride): string {
  const scope = 'query' in r.scope ? `{ query: ${JSON.stringify(r.scope.query)} }` : `{ variant: ${JSON.stringify(r.scope.variant)} }`;
  const parts = [`scope: ${scope}`];
  if (r.speed !== undefined) parts.push(`speed: ${round(r.speed)}`);
  if (r.hoverSpeed !== undefined) parts.push(`hoverSpeed: ${round(r.hoverSpeed)}`);
  if (r.draggable !== undefined) parts.push(`draggable: ${r.draggable}`);
  if (r.fade !== undefined) parts.push(`fade: ${round(r.fade)}`);
  if (r.disabled !== undefined) parts.push(`disabled: ${r.disabled}`);
  return `{ ${parts.join(', ')} }`;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** The config an opening tag spells (missing / unreadable props → defaults).
 *  Same reader as the parser (ticker-config.ts tickerFromJsxAttributes). */
export function parseTickerOpenTag(openTag: string): TickerConfig {
  const ast = parseJSX(`<>${openTag}</${TICKER_TAG}></>`);
  const frag = (ast?.program.body[0] as any)?.expression;
  const el = frag?.children?.find((c: any) => c.type === 'JSXElement');
  return el ? tickerFromJsxAttributes(el.openingElement.attributes) : normalizeTicker({});
}

/** The identifier a component's ticker reads its variant from: the `variant`
 *  state when the component has connections, else the `initialVariant` prop
 *  (same detection as the Text Effect's `variant` prop). */
function variantVarFor(code: string): string {
  return /\bconst\s*\[\s*variant\b/.test(code) ? 'variant' : 'initialVariant';
}

export type LiftedTickers = LiftedWrappers;

/** Strip every `<RevymeTicker>` wrapper, remembering which element each wrapped. */
export function liftTickers(code: string): { code: string; lifted: LiftedTickers } {
  return liftElementWrappers(code, TICKER_TAG);
}

/** Re-wrap each lifted element that still exists. */
export function restoreTickers(code: string, lifted: LiftedTickers): string {
  return restoreElementWrappers(code, lifted, TICKER_TAG);
}

/** The ticker on one element, or null. */
export function readTicker(code: string, nodeId: string): TickerConfig | null {
  const tag = liftTickers(code).lifted.get(nodeId);
  return tag ? parseTickerOpenTag(tag) : null;
}

/** Set (config) or remove (null) the Ticker effect on one element, and keep
 *  the `RevymeTicker` runtime import in sync. Unknown element → unchanged. */
export function setTickerInCode(code: string, nodeId: string, config: TickerConfig | null): string {
  trace.fn('generator.setTickerInCode', { nodeId, config });
  // Overrides come off first and go back last, so they land INSIDE the ticker.
  const { code: noOverrides, lifted: overrides } = liftCodeOverrides(code);
  const { code: plain, lifted } = liftTickers(noOverrides);
  if (!findSubtreeRange(plain, nodeId)) return code;
  if (config) lifted.set(nodeId, tickerOpenTag(config, variantVarFor(plain)));
  else lifted.delete(nodeId);
  return ensureRuntimeWrapperImport(restoreCodeOverrides(restoreTickers(plain, lifted), overrides), TICKER_TAG);
}

/** `RevymeTicker` import exactly while the file uses the wrapper. */
export function ensureRuntimeTickerImport(code: string): string {
  return ensureRuntimeWrapperImport(code, TICKER_TAG);
}
