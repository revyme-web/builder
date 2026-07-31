// generator-motion-loop.ts — Loop effects: the data-loop carrier attribute and
// Loop × everything compose/decompose (loop props as folded motion values).
// All code moved VERBATIM from generator-motion.ts (Phase 7.4 god-file split).
import { escapeRegExp } from '@/shared/regex-utils';
import { nodeIdToVarName } from '@/shared/id-utils';
import { insertBeforeRenderReturn, getJsonAttr, setTagAttr, isModuleScopeJsx, stripTagAttrBalanced } from './generator-utils';
import { ensureMediaQueryHook, ensureMediaGate, type SerScope } from './scoped-expr';
import { capProp, parseTagObject, isStyleMotionVar, emitObj } from './generator-motion-compose';
import { getOpeningTag, injectStyleMotionBinding } from './generator-motion-scroll-fx';

// ─────────────────────────────────────────────────────────────────────────────
// Loop × everything. A Loop is an object-form `animate={{…}}` with a REPEATING
// transition. Declaratively it (a) shares the single `transition` prop with Appear
// — so Appear inherits `repeat: Infinity` and flickers forever — and (b) fights any
// other effect on a shared prop (e.g. hover rotate). Compose turns each loop prop
// into its own motion value animated on mount with the LOOP's transition, folded
// into the prop's existing value (scale/opacity multiply, x/y/rotate/skew add).
// Appear then uses a repeat-free transition. Loop composes after appear/direction
// but before gestures, so a hover/tap on the same prop folds over the loop value.
// ─────────────────────────────────────────────────────────────────────────────
const LOOP_REPEAT_KEYS = ['repeat', 'repeatType', 'repeatDelay'];

/** The loop's separate-form carrier is a dedicated `data-loop='<json>'` attribute —
 *  NOT the `animate` JSX prop (which collides with a direction Scroll Animation) nor
 *  the shared `transition` prop (which collides with Appear). It holds
 *  `{ props, transition, offscreen? }`. Returns null when absent/empty. */
function getLoopAnimate(code: string, nodeId: string): { props: Record<string, string>; trans: Record<string, string>; offscreen?: string; scope?: SerScope[] } | null {
  const spec = getJsonAttr<{ props?: Record<string, string>; transition?: Record<string, string>; offscreen?: string; scope?: SerScope[] }>(code, nodeId, 'data-loop');
  if (!spec?.props || !Object.keys(spec.props).length) return null;
  return { props: spec.props, trans: spec.transition || {}, offscreen: spec.offscreen, scope: spec.scope };
}

/** Set / replace / remove (`spec = null`) a node's `data-loop` carrier. */
export function setLoopInCode(code: string, nodeId: string, spec: { props: Record<string, string>; transition: Record<string, string>; offscreen?: string; scope?: SerScope[] } | null): string {
  const keep = !!(spec && spec.props && Object.keys(spec.props).length);
  let result = setTagAttr(code, nodeId, 'data-loop', keep ? `'${JSON.stringify(spec)}'` : null);
  if (!keep) {
    // Removing a loop must also clear the CANVAS dormant form (declarative
    // animate + repeating transition on the tag — see composeCanvasLoop). The
    // hook form is dismantled by the decompose sweep; this form has no hooks.
    result = stripDormantLoopAttrs(result, nodeId);
  }
  return result;
}

/** The CANVAS (module-scope) loop form: a plain declarative repeating
 *  `animate={{…}}` + `transition={{…}}` on a `motion.*` tag — zero hooks, so it
 *  is legal inside the `canvasNodes` fragment and still plays on the canvas.
 *  Ensures `repeat: Infinity` when the spec's transition lacks it (the hook
 *  form embeds repeat in its animate() call the same way). */
function composeCanvasLoop(code: string, nodeId: string, loop: { props: Record<string, string>; trans: Record<string, string> }): string {
  const got = getOpeningTag(code, nodeId);
  if (!got) return code;

  // motion.* conversion (open + close tags) — animate on a plain tag is inert.
  const tagNameMatch = got.tag.match(/^<(motion\.\w+|[A-Za-z][\w.]*)/);
  if (!tagNameMatch) return code;
  const fullTag = tagNameMatch[1];
  const isMotion = fullTag.startsWith('motion.');
  const baseTag = isMotion ? fullTag.slice('motion.'.length) : fullTag;
  let result = code;
  if (!isMotion) {
    const selfClosing = /\/>$/.test(got.tag.trim());
    let newTag = got.tag.replace(/^<[A-Za-z][\w.]*/, `<motion.${baseTag}`);
    result = result.slice(0, got.tagStart) + newTag + result.slice(got.gt);
    if (!selfClosing) {
      // The matching close tag follows the opening — same depth-matching the
      // text-anim conversion uses is overkill for a leaf: replace the FIRST
      // `</tag>` after the opening (canvas tiles are leaves or shallow).
      const closeIdx = result.indexOf(`</${baseTag}>`, got.tagStart + newTag.length);
      if (closeIdx !== -1) {
        result = result.slice(0, closeIdx) + `</motion.${baseTag}>` + result.slice(closeIdx + `</${baseTag}>`.length);
      }
    }
  }

  // animate + repeating transition, replacing any previous dormant values.
  // NOTE getOpeningTag's `tag` EXCLUDES the closing '>' (gt = its index), so
  // append attrs at the end and let the splice keep the original '>'.
  const reGot = getOpeningTag(result, nodeId);
  if (!reGot) return code;
  let newTag = stripTagAttrBalanced(reGot.tag, 'animate');
  newTag = stripTagAttrBalanced(newTag, 'transition');
  const trans: Record<string, string> = ('repeat' in loop.trans) ? loop.trans : { repeat: 'Infinity', ...loop.trans };
  const selfClose = /\/\s*$/.test(newTag);
  if (selfClose) newTag = newTag.replace(/\/\s*$/, '');
  newTag = newTag.replace(/\s+$/, '')
    + ` animate={${emitObj(loop.props)}} transition={${emitObj(trans)}}`
    + (selfClose ? ' /' : '');
  return result.slice(0, reGot.tagStart) + newTag + result.slice(reGot.gt);
}

/** Strip the canvas-dormant declarative loop form: `animate={{…}}` plus a
 *  `transition` whose object carries `repeat` (the loop signature — an Appear's
 *  repeat-free transition is left alone). No-op when the tag has no animate. */
function stripDormantLoopAttrs(code: string, nodeId: string): string {
  const got = getOpeningTag(code, nodeId);
  if (!got || !/\banimate=\{/.test(got.tag)) return code;
  let newTag = stripTagAttrBalanced(got.tag, 'animate');
  const trans = parseTagObject(newTag, 'transition');
  if (trans && 'repeat' in trans) newTag = stripTagAttrBalanced(newTag, 'transition');
  if (newTag === got.tag) return code;
  return code.slice(0, got.tagStart) + newTag + code.slice(got.gt);
}

/** A loop ALWAYS needs composing — `data-loop` is not a real Motion attribute, so it
 *  only renders once turned into the imperative motion-value form. */
export function hasLoopConflict(code: string, nodeId: string): boolean {
  return !!getLoopAnimate(code, nodeId);
}

/** Compose a node's loop `animate={{…}}` into per-prop motion values that run on
 *  mount with the loop's repeating transition, folded into each prop's binding. */
export function composeLoopInCode(code: string, nodeId: string, loop = getLoopAnimate(code, nodeId)): string {
  // `loop` may be passed in by the orchestrator because the appear compose strips
  // the shared `transition` (the loop's repeat config) before we run — so we can't
  // always re-read it off the tag here. The animate={{…}} props ARE still present.
  if (!loop) return code;
  const cleanName = nodeIdToVarName(nodeId);
  const got = getOpeningTag(code, nodeId);
  if (!got) return code;

  // CANVAS NODE — the module-scope `canvasNodes` fragment can't hold the hook
  // form (useMotionValue/useEffect/useInView + ref would be undefined
  // identifiers there; the validator rightly blocked the add — live find
  // 2026-07-13, Loop on a marquee word tile). Emit the SELF-CONTAINED
  // declarative loop instead: `animate={{…}}` + the repeating `transition` on
  // a motion.* tag. Off Screen pause needs hooks → unavailable on the canvas.
  // `data-loop` STAYS on the tag as the spec carrier (panel round-trip); when
  // the node later moves into a viewport the sweep re-runs, the hook path
  // below strips this dormant form and composes the full effect.
  if (isModuleScopeJsx(code, got.tagStart)) {
    return composeCanvasLoop(code, nodeId, loop);
  }

  // A node dragged IN from the canvas still carries the dormant declarative
  // form — strip it first or it would double-run beneath the hook form.
  const codeClean = stripDormantLoopAttrs(code, nodeId);
  if (codeClean !== code) {
    code = codeClean;
    const reGotClean = getOpeningTag(code, nodeId);
    if (!reGotClean) return code;
    got.tag = reGotClean.tag; got.tagStart = reGotClean.tagStart; got.gt = reGotClean.gt;
  }
  const styleVars = parseTagObject(got.tag, 'style') || {};
  // Off Screen lives in the loop spec (not the transition). Default Pause (the reference)
  // gates the run-loop with useInView so it stops while scrolled out of view.
  const offscreenPause = loop.offscreen !== 'play';
  const transStr = emitObj(loop.trans);
  const refVar = `${cleanName}Ref`;
  const loopInView = `${cleanName}LoopInView`;
  const needsRef = offscreenPause && !new RegExp(`\\bconst ${refVar} = useRef\\(`).test(code);

  // PRESENCE: a loop added on a replica runs ONLY on its scope(s). We gate the whole
  // effect's PRESENCE (not just the keyframe target) — otherwise off-scope
  // `animate(mv, 0, { repeat: Infinity })` from a non-zero rotation loops [current, 0]
  // FOREVER instead of stopping. In-scope: the repeating loop. Off-scope: settle to the
  // resting value ONCE (no repeat) so it stops. The gate is in the effect deps so it
  // re-evaluates on a breakpoint crossing.
  let result = code;
  const gateVars: string[] = [];
  if (loop.scope?.length) {
    result = ensureMediaQueryHook(result);
    for (const s of loop.scope) {
      if ('query' in s && s.query !== undefined && !('locale' in s)) {
        const g = ensureMediaGate(result, s.query); result = g.code; gateVars.push(g.gateVar);
      } else if ('variant' in s) {
        gateVars.push(`variant === '${s.variant}'`);
      }
      // locale scopes don't participate in motion loops (no locale-gated
      // keyframe loops yet) — skipped rather than mis-gated.
    }
  }
  const presenceCond = gateVars.length ? gateVars.join(' || ') : null;
  const gateDeps = gateVars.filter((v) => /^__mq\d+$/.test(v));

  const newBindings: Record<string, string> = {};
  const declLines: string[] = [];
  if (offscreenPause) {
    if (needsRef) declLines.push(`  const ${refVar} = useRef(null);`);
    declLines.push(`  const ${loopInView} = useInView(${refVar});`);
  }
  for (const [prop, target] of Object.entries(loop.props)) {
    const mult = prop === 'opacity' || prop.startsWith('scale');
    const base = mult ? '1' : '0';
    const mv = `${cleanName}Loop${capProp(prop)}`;
    const deps = [...(offscreenPause ? [loopInView] : []), ...gateDeps].join(', ');
    const loopRun = `const _c = animate(${mv}, ${target}, ${transStr}); return () => _c.stop();`;
    declLines.push(`  const ${mv} = useMotionValue(${base});`);
    let body: string;
    if (presenceCond) {
      // Off-SCOPE → settle to rest ONCE (non-repeating) so a mid-rotation loop stops
      // cleanly when you grow past its viewport. In-scope but off-SCREEN → pause (freeze,
      // base off-screen behaviour). In-scope + on-screen → the repeating loop.
      body = `if (!(${presenceCond})) { const _s = animate(${mv}, ${base}, { duration: 0.3 }); return () => _s.stop(); } `
        + (offscreenPause ? `if (!${loopInView}) return; ` : '') + loopRun;
    } else if (offscreenPause) {
      body = `if (${loopInView}) { ${loopRun} }`;
    } else {
      body = loopRun;
    }
    declLines.push(`  useEffect(() => { ${body} }, [${deps}]);`);
    const existing = styleVars[prop];
    if (isStyleMotionVar(result, existing) && existing.trim() !== mv) {
      const combined = `${cleanName}${capProp(prop)}LpC`;
      declLines.push(`  const ${combined} = useTransform([${existing.trim()}, ${mv}], ([s, l]) => s ${mult ? '*' : '+'} l);`);
      newBindings[prop] = combined;
    } else {
      newBindings[prop] = mv;
    }
  }

  // `result` already holds any presence gate consts injected above.
  const withHooks = insertBeforeRenderReturn(result, declLines.join('\n'));
  if (withHooks === null) return code;
  result = withHooks;

  // Strip the loop's data-loop carrier from the tag; attach the useInView ref if we
  // created one for off-screen pausing.
  const reGot = getOpeningTag(result, nodeId);
  if (!reGot) return code;
  let newTag = reGot.tag.replace(/\s*data-loop='[^']*'/, '');
  if (needsRef && !new RegExp(`ref=\\{${refVar}\\}`).test(newTag)) {
    newTag = newTag.replace(/^(<[a-zA-Z][\w.]*)/, `$1 ref={${refVar}}`);
  }
  result = result.slice(0, reGot.tagStart) + newTag + result.slice(reGot.gt);

  for (const [prop, v] of Object.entries(newBindings)) {
    result = injectStyleMotionBinding(result, nodeId, prop, v);
  }
  return result;
}

/** Parse a `{ a: 1, b: 'x' }` object-literal string into a Record (quotes stripped). */
function parseObjLiteral(s: string): Record<string, string> {
  const o: Record<string, string> = {};
  for (const part of s.replace(/^\s*\{|\}\s*$/g, '').split(',')) {
    const i = part.indexOf(':');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim().replace(/^['"`]|['"`]$/g, '');
    if (k) o[k] = v;
  }
  return o;
}

/** Remove the `useEffect(() => { … }, [ … ])` that references `mv`, brace/string/paren-
 *  balanced so ANY body shape (the plain, off-screen-gated, OR presence-gated loop) is
 *  removed cleanly — a tight regex can't keep up with the gated `if (!(…)) {…}` form. */
function removeLoopEffect(code: string, mv: string): string {
  let result = code, from = 0;
  while (true) {
    const idx = result.indexOf('useEffect(', from);
    if (idx === -1) break;
    let depth = 0, inStr = '', end = -1;
    for (let i = idx + 'useEffect'.length; i < result.length; i++) {
      const ch = result[i];
      if (inStr) { if (ch === inStr) inStr = ''; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
      else if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) { from = idx + 10; continue; }
    let semi = end + 1;
    while (semi < result.length && (result[semi] === ' ' || result[semi] === '\t')) semi++;
    if (result[semi] === ';') semi++;
    if (new RegExp(`\\b${mv}\\b`).test(result.slice(idx, semi))) {
      let start = idx;
      while (start > 0 && (result[start - 1] === ' ' || result[start - 1] === '\t')) start--;
      if (result[start - 1] === '\n') start--;
      result = result.slice(0, start) + result.slice(semi);
      from = start;
    } else from = semi;
  }
  return result;
}

/** Inverse of composeLoopInCode — restore the `data-loop` carrier. */
export function decomposeLoopInCode(code: string, nodeId: string): string {
  const cleanName = nodeIdToVarName(nodeId);
  const cn = escapeRegExp(cleanName);
  const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
  const mvRe = new RegExp(`const ${cn}Loop(\\w+) = useMotionValue\\([^;]*\\);`, 'g');
  const mvs = [...code.matchAll(mvRe)];
  if (mvs.length === 0) return code;

  // Prefer the AUTHORITATIVE loop spec from the data-scroll-fx attr — it carries
  // props/transition/offscreen/SCOPE and is still present here (decomposeAllScrollConflicts
  // strips it only at the very end). Parsing the composed useEffect is the fallback for a
  // loop with no attr. Without this, a scoped loop lost its `scope` on decompose → recompose
  // re-emitted it as a base (every-viewport) loop.
  const attrLoop: { props?: Record<string, string>; transition?: Record<string, string>; offscreen?: string; scope?: SerScope[] } | null =
    getJsonAttr<{ loop?: { props?: Record<string, string>; transition?: Record<string, string>; offscreen?: string; scope?: SerScope[] } }>(code, nodeId, 'data-scroll-fx')?.loop ?? null;

  let result = code;
  const props: Record<string, string> = {};
  let trans = '';
  const gated = new RegExp(`\\bconst ${cn}LoopInView = useInView\\(`).test(code);
  for (const m of mvs) {
    const Prop = m[1], prop = lower(Prop);
    const mv = `${cn}Loop${Prop}`;
    // The REPEAT loop animate (NOT the off-scope `{ duration: 0.3 }` settle) — pick the
    // one whose transition has `repeat`.
    const ams = [...result.matchAll(new RegExp(`animate\\(${mv},\\s*([^,]+),\\s*(\\{[^}]*\\})\\)`, 'g'))];
    const loopAm = ams.find((a) => /repeat/.test(a[2])) ?? ams[0];
    if (loopAm) { props[prop] = loopAm[1].trim(); if (!trans) trans = loopAm[2]; }
    const combinedRe = new RegExp(`const ${cn}${Prop}LpC = useTransform\\(\\[(\\w+),\\s*${mv}\\][^;]*\\);`);
    const cm = result.match(combinedRe);
    if (cm) {
      result = result.replace(new RegExp(`${prop}:\\s*${cn}${Prop}LpC`), `${prop}: ${cm[1]}`);
      result = result.replace(new RegExp(`\\s*const ${cn}${Prop}LpC = useTransform\\([^;]*\\);`), '');
    } else {
      result = result.replace(new RegExp(`,?\\s*${prop}:\\s*${mv}\\b`), '');
    }
    result = result.replace(new RegExp(`\\s*const ${mv} = useMotionValue\\([^;]*\\);`), '');
    result = removeLoopEffect(result, mv);
  }
  result = result.replace(new RegExp(`\\s*const ${cn}LoopInView = useInView\\([^;]*\\);`), '');
  const finalProps = (attrLoop?.props && Object.keys(attrLoop.props).length) ? attrLoop.props : props;
  if (Object.keys(finalProps).length) {
    const spec = {
      props: finalProps,
      transition: attrLoop?.transition ?? parseObjLiteral(trans),
      ...(attrLoop?.offscreen ? { offscreen: attrLoop.offscreen } : (gated ? {} : { offscreen: 'play' })),
      ...(attrLoop?.scope?.length ? { scope: attrLoop.scope } : {}),
    };
    result = setLoopInCode(result, nodeId, spec);
  }
  return result;
}

export { LOOP_REPEAT_KEYS, getLoopAnimate, parseObjLiteral, removeLoopEffect };
