// instance-size-override.ts — Let a component INSTANCE's width/height override
// the master's variant size, per instance.
//
// A variant-component root is `<motion.div variants={X} animate={variant}
// style={{ …, ...style }}>`. When the variant object `X.default` carries
// `width: '1440px'`, framer-motion drives the width from the variant as a live
// motion value — and a motion value ALWAYS beats the `style` prop. So an
// instance's `<NeZaFi style={{ width: '100%' }}>` is clobbered: every instance
// paints at the variant's width, no matter what the instance sets.
//
// the reference instead lets each instance override the variant size independently
// (one 400px, one 80%, one fill). To match that we merge the instance's
// width/height INTO the root's variants object at runtime, keeping
// `animate={variant}` a string label so child-variant propagation still works:
//
//   const { width: __instW, height: __instH, ...__instStyle } = style ?? {};
//   <motion.div variants={__applyInstanceSize(X, __instW, __instH)} animate={variant}
//               style={{ …, ...__instStyle }} />
//
// `__applyInstanceSize` overrides width/height on EVERY variant entry, so the
// instance's size holds across its own variant transitions. When the instance
// sets neither, it returns the variants object untouched (zero behavior change
// for the common case). Self-contained per file — a plain module-level helper,
// no import, no runtime-package change. ProjectFS stays the source of truth.

import { trace } from '@/shared/debug-trace';

const HELPER = `function __applyInstanceSize(variants, w, h) {
  if (w === undefined && h === undefined) return variants;
  const out = {};
  for (const k in variants) {
    out[k] = { ...variants[k], ...(w !== undefined ? { width: w } : {}), ...(h !== undefined ? { height: h } : {}) };
  }
  return out;
}
`;

/** Has this component already been wired for instance size override? */
export function hasInstanceSizeOverride(code: string): boolean {
  return code.includes('__applyInstanceSize');
}

/**
 * Wire a variant-component file so its instance's width/height override the
 * master's variant size. Idempotent; returns the input unchanged when the root
 * isn't variant-controlled (no `variants={…}` on the `...style` root) or the
 * signature isn't recognizable — in those cases the instance's `...style`
 * width already wins, so nothing is needed.
 */
export function ensureInstanceSizeOverride(code: string): string {
  if (hasInstanceSizeOverride(code)) return code;

  // The root element is the one that spreads the instance `...style`.
  const spreadIdx = code.indexOf('...style');
  if (spreadIdx === -1) return code;
  const tagStart = code.lastIndexOf('<motion.', spreadIdx);
  if (tagStart === -1) return code;

  // Root must be variant-controlled — `variants={IDENT}` BEFORE the style attr.
  const variantsAttrIdx = code.indexOf('variants={', tagStart);
  if (variantsAttrIdx === -1 || variantsAttrIdx > spreadIdx) {
    trace.fn('instance-size-override:root-not-variant-controlled', {});
    return code;
  }
  const identStart = variantsAttrIdx + 'variants={'.length;
  const identEnd = code.indexOf('}', identStart);
  if (identEnd === -1) return code;
  const ident = code.slice(identStart, identEnd).trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(ident)) {
    trace.fn('instance-size-override:variants-not-identifier', { ident });
    return code;
  }

  // The component function that destructures `style`.
  const fnRe = /function\s+\w+\s*\([^)]*\bstyle\b[^)]*\)\s*\{/;
  const fnMatch = fnRe.exec(code);
  if (!fnMatch) {
    trace.fn('instance-size-override:no-style-fn', {});
    return code;
  }
  const fnOpen = fnMatch[0];

  let out = code;
  // a) variants={IDENT} → variants={__applyInstanceSize(IDENT, __instW, __instH)}
  out = out.replace(`variants={${ident}}`, `variants={__applyInstanceSize(${ident}, __instW, __instH)}`);
  // b) root ...style → ...__instStyle (width/height stripped into the destructure)
  out = out.replace('...style', '...__instStyle');
  // c) destructure as the first statement in the component body
  out = out.replace(fnOpen, `${fnOpen}\n  const { width: __instW, height: __instH, ...__instStyle } = style ?? {};`);
  // d) module-level helper, just before the component function
  out = out.replace(fnOpen, `${HELPER}\n${fnOpen}`);

  trace.fn('instance-size-override:applied', { ident });
  return out;
}
