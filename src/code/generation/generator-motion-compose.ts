// generator-motion-compose.ts — conflict compose/decompose: Appear × Scroll
// Transform (standard multiply) and Hover/Tap gesture × scroll folding.
// All code moved VERBATIM from generator-motion.ts (Phase 7.4 god-file split).
import { escapeRegExp } from '@/shared/regex-utils';
import { nodeIdToVarName } from '@/shared/id-utils';
import { parseScrollHooks, getScrollDataForNode, parseScrollDirection } from '../parsing/scroll-parser';
import { trace } from '@/shared/debug-trace';
import { findTagClose, findJSXDataIdIndex, insertBeforeRenderReturn, stripTagAttrBalanced } from './generator-utils';
import { splitStyleProps } from '@/shared/css-utils';
import { scopeKey, parseScopedScalarExpr, type SerScope } from './scoped-expr';
import { findMotionPropExpr, parseScopedExpr } from './generator-motion-props';
import { LOOP_REPEAT_KEYS, parseObjLiteral } from './generator-motion-loop';
import { getOpeningTag, injectStyleMotionBinding, emitMotionPropResponsive, type FxScopeOverride } from './generator-motion-scroll-fx';

// ─── Compose Appear × Scroll Transform (standard multiply) ───────────────
//
// When a node has BOTH a Motion Appear (initial/whileInView/viewport) AND a
// scrubbed Scroll Transform (style bindings to useTransform values), they fight
// over shared props (e.g. both set opacity). the reference COMPOSES them: the appear
// reveal MULTIPLIES the transform. We rewrite to a single motion value per prop:
//
//   const ref = useRef(null);
//   const inView = useInView(ref, { once: true });
//   const appear = useSpring(inView ? 1 : 0, { duration, bounce });   // reveal 0→1
//   ... existing useScroll/useSpring/useTransform (transform) ...
//   const opacityC = useTransform([appear, tOpacity], ([a, t]) => a * t); // shared → ×
//   const y = useTransform(appear, [0, 1], [30, 0]);                      // appear-only
//   style={{ …, opacity: opacityC, scale: tScale, y }}  ref={ref}
//   // initial / whileInView / viewport removed.

const capProp = (k: string) => k.charAt(0).toUpperCase() + k.slice(1);

/** Parse a flat `prop={{ k: v, … }}` object off a tag string into a string map. */
function parseTagObject(tag: string, prop: string): Record<string, string> | null {
  const m = tag.match(new RegExp(`${prop}=\\{\\{([^}]*)\\}\\}`));
  if (!m) return null;
  const o: Record<string, string> = {};
  // splitStyleProps is bracket+paren+quote aware — a raw `.split(',')` would
  // shatter an array value like `ease: [0.16, 1, 0.3, 1]` at its inner commas
  // (→ key `ease`, value `[0.16`), the same corruption class the CSS splitter
  // had. Read-only here, but correct reads matter for the conflict detection.
  for (const part of splitStyleProps(m[1])) {
    const idx = part.indexOf(':');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim().replace(/^['"`]|['"`]$/g, '');
    if (k) o[k] = v;
  }
  return o;
}

/** True when `nodeId` has a Motion appear (whileInView, non-variant) that shares a
 *  property with a scroll-driven STYLE motion value — a scrubbed Scroll Transform
 *  binding OR another effect's binding like Scroll Speed's `y`. Either way the
 *  appear's declarative prop and the style motion value fight, so they must be
 *  composed. (getScrollDataForNode excludes Speed, so we also scan style vars.) */
export function hasAppearTransformConflict(code: string, nodeId: string): boolean {
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return false;
  const tagStart = code.lastIndexOf('<', idIdx);
  const tagEnd = findTagClose(code, idIdx);
  if (tagStart === -1 || tagEnd === -1) return false;
  const tag = code.slice(tagStart, tagEnd + 1);
  if (!/whileInView=\{\{/.test(tag)) return false;
  const scroll = getScrollDataForNode(parseScrollHooks(code), nodeId);
  if (scroll.bindings.length > 0) return true;
  // No scrubbed transform, but a sibling effect (e.g. Scroll Speed) may bind a
  // style motion value on a prop the appear also animates → still a conflict.
  const initial = parseTagObject(tag, 'initial') || {};
  const whileInView = parseTagObject(tag, 'whileInView') || {};
  const styleVars = parseTagObject(tag, 'style') || {};
  for (const k of new Set([...Object.keys(initial), ...Object.keys(whileInView)])) {
    const v = styleVars[k];
    if (v && /^[A-Za-z_$][\w$]*$/.test(v.trim())) return true;
  }
  return false;
}

/** Compose a node's Appear × Scroll Transform into combined motion values
 *  (the reference multiply). No-op if the node doesn't have both. */
export function composeScrollAppearInCode(code: string, nodeId: string): string {
  trace.fn('generator.composeScrollAppear', { nodeId });
  if (!hasAppearTransformConflict(code, nodeId)) return code;
  const cleanName = nodeIdToVarName(nodeId);

  const idIdx = findJSXDataIdIndex(code, nodeId);
  const tagStart = code.lastIndexOf('<', idIdx);
  let gt = -1, depth = 0, inStr = '';
  for (let i = idIdx; i < code.length; i++) {
    const ch = code[i];
    if (inStr) { if (ch === inStr) inStr = ''; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    else if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && depth === 0) { gt = i; break; }
  }
  if (gt === -1) return code;
  const tag = code.slice(tagStart, gt + 1);

  const initial = parseTagObject(tag, 'initial') || {};
  const whileInView = parseTagObject(tag, 'whileInView') || {};
  const viewport = parseTagObject(tag, 'viewport');
  const once = viewport?.once === 'true';
  // The Appear reveal runs ONCE. If the shared `transition` carries a loop's
  // repeat keys, drop them (and if that empties it, fall back to the default
  // spring) so the appear never inherits `repeat: Infinity` and flicker-loops.
  const transRec = parseTagObject(tag, 'transition');
  const appearTrans = transRec
    ? Object.fromEntries(Object.entries(transRec).filter(([k]) => !LOOP_REPEAT_KEYS.includes(k) && k !== '__offscreen'))
    : null;
  const springParams = appearTrans && Object.keys(appearTrans).length
    ? emitObj(appearTrans) : `{ type: 'spring', duration: 0.5, bounce: 0.25 }`;

  // Transform bindings (prop → transform var) from the scrubbed scroll.
  const scroll = getScrollDataForNode(parseScrollHooks(code), nodeId);
  const transformByProp: Record<string, string> = {};
  for (const b of scroll.bindings) transformByProp[b.property] = b.transformVar;

  // EXISTING style motion-var bindings (e.g. Scroll Speed's `y: …SpeedY`). When
  // an appear prop also has one of these, we must COMBINE, not overwrite — else
  // the sibling effect (parallax) is orphaned. getScrollDataForNode excludes
  // Speed, so this is the only place we see it.
  const styleVars = parseTagObject(tag, 'style') || {};
  const isMotionVar = (v: string | undefined) => !!v && /^[A-Za-z_$][\w$]*$/.test(v.trim());

  const appearKeys = new Set<string>([...Object.keys(initial), ...Object.keys(whileInView)]);
  const refVar = `${cleanName}Ref`;
  const inViewVar = `${cleanName}InView`;
  const appearVar = `${cleanName}Appear`;

  const newBindings: Record<string, string> = {};       // styleProp → motion var
  const composedLines: string[] = [];
  for (const key of appearKeys) {
    // opacity/scale combine MULTIPLICATIVELY (a gate); translations/rotations
    // combine ADDITIVELY (offsets stack — entrance offset + parallax).
    const mult = key === 'opacity' || key.startsWith('scale');
    if (transformByProp[key]) {
      // Shared with the scrubbed transform → multiply appear reveal by it.
      const v = `${cleanName}${capProp(key)}C`;
      composedLines.push(`  const ${v} = useTransform([${appearVar}, ${transformByProp[key]}], ([a, t]) => a * t);`);
      newBindings[key] = v;
    } else {
      // Appear-only prop → map the reveal [0,1] onto [initial, resting].
      const neutral = mult ? '1' : '0';
      const initV = initial[key] ?? neutral;
      const restV = whileInView[key] ?? neutral;
      const ya = `${cleanName}${capProp(key)}A`;
      composedLines.push(`  const ${ya} = useTransform(${appearVar}, [0, 1], [${initV}, ${restV}]);`);
      // A sibling effect (Scroll Speed) already drives this prop → fold its
      // motion value in: `<cn><Prop>AC = useTransform([<Prop>A, <siblingVar>], …)`.
      const sibling = styleVars[key];
      if (isMotionVar(sibling) && sibling.trim() !== ya) {
        const v = `${cleanName}${capProp(key)}AC`;
        const op = mult ? 'a * b' : 'a + b';
        composedLines.push(`  const ${v} = useTransform([${ya}, ${sibling.trim()}], ([a, b]) => ${op});`);
        newBindings[key] = v;
      } else {
        newBindings[key] = ya;
      }
    }
  }

  // Insert the appear-reveal hooks + composed transforms right before `return`.
  // SINGLE element (like the reference — no wrapper): a useMotionValue reveal (0→1)
  // driven IMPERATIVELY by `animate()` when in view. `useSpring(mv)` + `.set()`
  // does NOT animate in Motion v12 (confirmed) — animate() does. The composed
  // lines reference the transform vars already declared above.
  // Reuse an existing `${cn}Ref` (e.g. one a Loop created for its off-screen gate) —
  // both effects key the ref off cleanName, so re-declaring it would be a duplicate
  // `const` → "already declared". The ref attach below is likewise guarded.
  const refEsc = escapeRegExp(refVar);
  const refExists = new RegExp(`\\bconst ${refEsc} = useRef\\(`).test(code);
  const appearLines = [
    ...(refExists ? [] : [`  const ${refVar} = useRef(null);`]),
    `  const ${inViewVar} = useInView(${refVar}, { once: ${once} });`,
    `  const ${appearVar} = useMotionValue(0);`,
    `  useEffect(() => { if (${inViewVar}) { const _c = animate(${appearVar}, 1, ${springParams}); return () => _c.stop(); } }, [${inViewVar}]);`,
  ];
  let result = code;
  const withHooks = insertBeforeRenderReturn(result, [...appearLines, ...composedLines].join('\n'));
  if (withHooks === null) return code;
  result = withHooks;

  // Strip the declarative appear props from the tag.
  const reTagStart = result.lastIndexOf('<', findJSXDataIdIndex(result, nodeId));
  let reGt = -1; depth = 0; inStr = '';
  for (let i = reTagStart; i < result.length; i++) {
    const ch = result[i];
    if (inStr) { if (ch === inStr) inStr = ''; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    else if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && depth === 0) { reGt = i; break; }
  }
  let newTag = result.slice(reTagStart, reGt + 1);
  newTag = newTag
    .replace(/\s*initial=\{\{[^}]*\}\}/g, '')
    .replace(/\s*whileInView=\{\{[^}]*\}\}/g, '')
    .replace(/\s*viewport=\{\{[^}]*\}\}/g, '')
    .replace(/\s*transition=\{\{[^}]*\}\}/g, '');
  // Attach the ref (for useInView) if not already present.
  if (!new RegExp(`ref=\\{${refVar}\\}`).test(newTag)) {
    newTag = newTag.replace(/^<([a-zA-Z][\w.]*)/, `<$1 ref={${refVar}}`);
  }
  result = result.slice(0, reTagStart) + newTag + result.slice(reGt + 1);

  // Re-point / add the style bindings to the composed vars.
  for (const [prop, v] of Object.entries(newBindings)) {
    result = injectStyleMotionBinding(result, nodeId, prop, v);
  }
  return dedupeAppearHooks(result);
}

/**
 * Self-heal the Motion-Appear hooks: an appear effect is
 *   `useEffect(() => { if (<X>InView) { const _c = animate(<X>Appear, 1, …); return () => _c.stop(); } }, [<X>InView]);`
 * declared alongside `const <X>InView = useInView(…)` + `const <X>Appear = useMotionValue(0)`.
 *
 * Multi-pass scroll regeneration (e.g. per-viewport) has been observed to leave
 * DUPLICATE appear effects, and — worse — to leave them ABOVE the `const`
 * declarations they reference. That's a temporal-dead-zone `ReferenceError`
 * ("Cannot access '<X>InView' before initialization") under production SSR
 * (Rolldown), even though the dev/canvas transform tolerates it — a live page
 * renders on the canvas but throws 1101 on deploy.
 *
 * Fix, path-agnostically: strip EVERY appear effect, then re-insert exactly one
 * per `<X>Appear`, immediately after its `const <X>Appear = useMotionValue(0);`
 * line — guaranteeing single + correctly-ordered (decl-before-use). Touches only
 * this exact generated shape, so it's safe to run after any scroll edit.
 */
export function dedupeAppearHooks(code: string): string {
  // Brace/string-tolerant match of the appear effect. Anchored on
  // `animate(<appearVar>, 1, …)` + dep array `[<inViewVar>]` (same var as the
  // `if (<inViewVar>)` guard) so it can't grab an unrelated useEffect.
  const re = /[ \t]*useEffect\(\(\) => \{\s*if \((\w+)\) \{\s*const _c = animate\((\w+), 1,[\s\S]*?return \(\) => _c\.stop\(\);\s*\}\s*\}, \[\1\]\);[ \t]*\r?\n?/g;
  const byAppear = new Map<string, string>();  // appearVar → effect text (deduped)
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const appearVar = m[2];
    if (!byAppear.has(appearVar)) {
      byAppear.set(appearVar, `  useEffect(() => { if (${m[1]}) { const _c = animate(${appearVar}, 1, ${effectParams(m[0])}); return () => _c.stop(); } }, [${m[1]}]);`);
    }
  }
  if (byAppear.size === 0) return code;
  // Remove every appear effect occurrence.
  let out = code.replace(re, '');
  // Re-insert one per appearVar, right after its useMotionValue declaration.
  for (const [appearVar, text] of byAppear) {
    const anchor = new RegExp(`(const ${appearVar} = useMotionValue\\(0\\);)`);
    if (anchor.test(out)) out = out.replace(anchor, `$1\n${text}`);
    // No anchor const → leave removed (can't place safely); shouldn't occur for
    // a valid appear, and dropping a duplicated-but-anchorless effect is safe.
  }
  return out;
}

/** Pull the `animate(...)` transition object literal out of a matched appear
 *  effect so the re-inserted (canonical, single-line) effect keeps the exact
 *  spring/tween params. Falls back to a default spring if not parseable. */
function effectParams(effectText: string): string {
  const m = effectText.match(/animate\(\w+, 1, (\{[\s\S]*?\})\);/);
  return m ? m[1].replace(/\s+/g, ' ').trim() : `{ type: 'spring', duration: 0.5, bounce: 0.25 }`;
}

/** Remove an `attr={…}` (brace/string-aware) from a single JSX tag string. */
function stripJsxAttr(tag: string, attr: string): string {
  const idx = tag.indexOf(`${attr}={`);
  if (idx === -1) return tag;
  let i = idx + attr.length + 1; // at the opening `{`
  let depth = 0, inStr = '';
  for (; i < tag.length; i++) {
    const ch = tag[i];
    if (inStr) { if (ch === inStr) inStr = ''; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  let start = idx;
  while (start > 0 && /\s/.test(tag[start - 1])) start--;
  return tag.slice(0, start) + tag.slice(i);
}

/** True when a node has BOTH a direction-triggered Scroll Animation (`animate=`
 *  ternary) and a scrubbed Scroll Transform (style bindings) that SHARE a prop —
 *  they fight over that prop (e.g. both set opacity → flashing). */
export function hasDirectionTransformConflict(code: string, nodeId: string): boolean {
  const dir = parseScrollDirection(code, nodeId);
  if (!dir) return false;
  const scroll = getScrollDataForNode(parseScrollHooks(code), nodeId);
  if (scroll.bindings.length === 0) return false;
  const tProps = new Set(scroll.bindings.map(b => b.property));
  return Object.keys(dir.toProps).some(k => dir.toProps[k] !== '' && tProps.has(k));
}

/** Compose a node's direction-triggered Scroll Animation × scrubbed Scroll
 *  Transform into combined motion values (the reference multiply) on ONE element. The
 *  `scrolled` state + useMotionValueEvent stay; the `animate`/`transition` props
 *  are replaced by motion values driven imperatively by `animate()`. */
function composeScrollDirectionTransformInCode(code: string, nodeId: string): string {
  trace.fn('generator.composeScrollDirectionTransform', { nodeId });
  if (!hasDirectionTransformConflict(code, nodeId)) return code;
  const cleanName = nodeIdToVarName(nodeId);
  const dir = parseScrollDirection(code, nodeId);
  if (!dir) return code;

  const scroll = getScrollDataForNode(parseScrollHooks(code), nodeId);
  const transformByProp: Record<string, string> = {};
  for (const b of scroll.bindings) transformByProp[b.property] = b.transformVar;

  const condVar = `${cleanName}Scrolled`;
  const transition = dir.transition && Object.keys(dir.transition).length
    ? `{ ${Object.entries(dir.transition).filter(([, v]) => v !== '').map(([k, v]) => `${k}: ${isNaN(Number(v)) ? `'${v}'` : v}`).join(', ')} }`
    : `{ type: 'spring', duration: 0.5, bounce: 0.25 }`;

  const animLines: string[] = [];
  const composedLines: string[] = [];
  const newBindings: Record<string, string> = {};
  for (const key of Object.keys(dir.toProps)) {
    if (dir.toProps[key] === '') continue;
    const resting = (key === 'opacity' || key.startsWith('scale')) ? '1' : '0';
    const active = dir.toProps[key];
    const animVar = `${cleanName}Anim${capProp(key)}`;
    // The reveal toggles resting↔active off the `scrolled` state via animate().
    animLines.push(`  const ${animVar} = useMotionValue(${resting});`);
    animLines.push(`  useEffect(() => { const _c = animate(${animVar}, ${condVar} ? ${active} : ${resting}, ${transition}); return () => _c.stop(); }, [${condVar}]);`);
    if (transformByProp[key]) {
      // Shared with the transform → MULTIPLY (one motion value, no fight).
      const cVar = `${cleanName}${capProp(key)}DC`;
      composedLines.push(`  const ${cVar} = useTransform([${animVar}, ${transformByProp[key]}], ([a, t]) => a * t);`);
      newBindings[key] = cVar;
    } else {
      // Animation-only prop → bind straight to its reveal motion value.
      newBindings[key] = animVar;
    }
  }
  if (Object.keys(newBindings).length === 0) return code;

  let result = code;
  const withHooks = insertBeforeRenderReturn(result, [...animLines, ...composedLines].join('\n'));
  if (withHooks === null) return code;
  result = withHooks;

  // Strip the declarative animate + transition props from the tag.
  const idIdx = findJSXDataIdIndex(result, nodeId);
  if (idIdx === -1) return code;
  const tagStart = result.lastIndexOf('<', idIdx);
  let gt = -1, depth = 0, inStr = '';
  for (let i = tagStart; i < result.length; i++) {
    const ch = result[i];
    if (inStr) { if (ch === inStr) inStr = ''; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    else if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && depth === 0) { gt = i; break; }
  }
  if (gt === -1) return code;
  let newTag = result.slice(tagStart, gt + 1);
  newTag = stripJsxAttr(stripJsxAttr(newTag, 'animate'), 'transition');
  result = result.slice(0, tagStart) + newTag + result.slice(gt + 1);

  for (const [prop, v] of Object.entries(newBindings)) {
    result = injectStyleMotionBinding(result, nodeId, prop, v);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hover / Tap × scroll compose. A style MotionValue OWNS its property, so a
// declarative whileHover/whileTap on the SAME prop is ignored by Motion. To blend
// like the reference, turn the gesture into its own motion value (rest 1 for scale/opacity,
// 0 for translations) animated by onHoverStart/End | onTapStart/onTap(+Cancel), and
// fold it into that property's existing motion value: scale/opacity MULTIPLY, x/y/
// rotate ADD. Props the scroll doesn't drive stay declarative in whileHover/whileTap.
// ─────────────────────────────────────────────────────────────────────────────
const GESTURES = {
  hover: { whileProp: 'whileHover', startEv: 'onHoverStart', endEvs: ['onHoverEnd'], cap: 'Hov' },
  tap: { whileProp: 'whileTap', startEv: 'onTapStart', endEvs: ['onTap', 'onTapCancel'], cap: 'Tap' },
} as const;
type GestureKind = keyof typeof GESTURES;
const GESTURE_TRANS = `{ type: 'spring', stiffness: 400, damping: 30 }`;
/** A style value is a MOTION VALUE only when it's an identifier AND the file
 *  actually declares it as one (`const v = useMotionValue/useTransform/useSpring(` or
 *  `useMotionTemplate\``). Shape alone is NOT enough: parseTagObject strips quotes,
 *  so a CSS keyword ('transparent', 'auto', 'none') is indistinguishable from an
 *  identifier — and folding one into a useTransform emits it UNQUOTED, a dangling
 *  identifier that the mutation validator blocks (whole flush reverts). Live
 *  failure 2026-06-10: editing ANY transition on a page where another node had
 *  style backgroundColor: 'transparent' + whileHover on backgroundColor. */
const isStyleMotionVar = (code: string, v: string | undefined): boolean => {
  if (!v) return false;
  const id = v.trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(id)) return false;
  return new RegExp(`\\bconst\\s+${id}\\s*=\\s*(use(MotionValue|Transform|Spring)\\s*\\(|useMotionTemplate\\s*\`)`).test(code);
};
// parseTagObject strips quotes, so re-quote non-numeric/non-boolean literals
// (CSS strings like 'red'/'10px') when re-emitting a gesture object. Numbers
// (1.05) and booleans stay bare.
const emitVal = (v: string) => (/^-?\d*\.?\d+$/.test(v.trim()) || ['true', 'false', 'Infinity', '-Infinity'].includes(v.trim())) ? v : `'${v}'`;
const emitObj = (o: Record<string, string>) => `{ ${Object.entries(o).map(([k, v]) => `${k}: ${emitVal(v)}`).join(', ')} }`;

const gestureRest = (p: string) => (p === 'opacity' || p.startsWith('scale')) ? '1' : '0';

/** Per-prop ANIMATE-TARGET expressions for a gesture, handling BOTH the plain
 *  `whileHover={{…}}` form AND the responsive `whileHover={test ? {…} : base}` chain.
 *  For the responsive form each target is a ternary with the prop's RESTING value as the
 *  off-scope/absent branch, so a SCOPED gesture composes correctly (gated, neutral where
 *  absent — fixes a tablet-only hover fighting a scroll-transform on the same prop instead
 *  of blending). `tests` carries the per-override gate strings so the remaining
 *  (non-conflicting) props can be re-emitted in gated form. Null = no gesture prop. */
function gestureTargetExprs(code: string, nodeId: string, whileProp: string):
  { targets: Record<string, string>; gated: boolean; baseObj: Record<string, string>; ovParsed: Array<{ test: string; obj: Record<string, string> }> } | null {
  const tag = getOpeningTag(code, nodeId)?.tag ?? '';
  const plain = parseTagObject(tag, whileProp);
  if (plain) {
    const targets: Record<string, string> = {};
    for (const [k, v] of Object.entries(plain)) targets[k] = emitVal(v);
    return { targets, gated: false, baseObj: plain, ovParsed: [] };
  }
  // Responsive/gated form — peel the `test ? {…} :` chain off the inner expression.
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return null;
  const expr = findMotionPropExpr(code, nodeId, whileProp);
  if (!expr) return null;
  const { base, overrides } = parseScopedExpr(code.slice(expr.start, expr.end));
  const baseObj = base.trim() === 'undefined' ? {} : (parseObjLiteral(base) || {});
  const ovParsed = [...overrides].map(([test, objStr]) => ({ test, obj: parseObjLiteral(objStr) || {} }));
  const allProps = new Set<string>([...Object.keys(baseObj), ...ovParsed.flatMap((o) => Object.keys(o.obj))]);
  const targets: Record<string, string> = {};
  for (const p of allProps) {
    const rest = gestureRest(p);
    let e = baseObj[p] != null ? emitVal(baseObj[p]) : rest;
    for (let i = ovParsed.length - 1; i >= 0; i--) {
      const v = ovParsed[i].obj[p] != null ? emitVal(ovParsed[i].obj[p]) : rest;
      e = `${ovParsed[i].test} ? ${v} : ${e}`;
    }
    targets[p] = ovParsed.length ? `(${e})` : e;
  }
  return { targets, gated: ovParsed.length > 0, baseObj, ovParsed };
}

/** Props of a node's whileHover/whileTap that ALSO have a style motion-var binding
 *  (so the declarative gesture is overridden and must be composed). Handles the plain
 *  AND the responsive (gated) gesture forms. */
function gestureConflictProps(code: string, nodeId: string, kind: GestureKind): string[] {
  const t = gestureTargetExprs(code, nodeId, GESTURES[kind].whileProp);
  if (!t) return [];
  const styleVars = parseTagObject(getOpeningTag(code, nodeId)?.tag ?? '', 'style') || {};
  return Object.keys(t.targets).filter(p => isStyleMotionVar(code, styleVars[p]));
}

/** True when any gesture (hover/tap) shares a prop with a style motion value. */
export function hasGestureTransformConflict(code: string, nodeId: string): boolean {
  return gestureConflictProps(code, nodeId, 'hover').length > 0
      || gestureConflictProps(code, nodeId, 'tap').length > 0;
}

/** Compose a node's whileHover/whileTap into the scroll motion values it shares a
 *  property with. No-op when there's no conflict. */
export function composeGestureInCode(code: string, nodeId: string, kind: GestureKind): string {
  const conflicts = gestureConflictProps(code, nodeId, kind);
  if (conflicts.length === 0) return code;
  const cfg = GESTURES[kind];
  const cleanName = nodeIdToVarName(nodeId);

  const got = getOpeningTag(code, nodeId);
  if (!got) return code;
  const gt = gestureTargetExprs(code, nodeId, cfg.whileProp);
  const targets = gt?.targets ?? {};
  const styleVars = parseTagObject(got.tag, 'style') || {};

  const newBindings: Record<string, string> = {};
  const declLines: string[] = [];
  const startAnims: string[] = [];
  const endAnims: string[] = [];
  for (const prop of conflicts) {
    const mult = prop === 'opacity' || prop.startsWith('scale');
    const rest = mult ? '1' : '0';
    // The hover/tap TARGET — gated `(test ? ov : rest)` for a responsive gesture, bare
    // value for a plain one. Off-scope it resolves to `rest` (neutral), so a tablet-only
    // hover folded into the scroll's scale motion value is a no-op on other viewports.
    const target = targets[prop] ?? rest;
    const mv = `${cleanName}${cfg.cap}${capProp(prop)}`;
    const existing = styleVars[prop].trim();
    const combined = `${cleanName}${capProp(prop)}${cfg.cap}C`;
    declLines.push(`  const ${mv} = useMotionValue(${rest});`);
    // Guard: never fold into the var we're about to declare. `existing === combined`
    // can only arise from an already-corrupt binding (a self-ref useTransform reads
    // undefined.get → crash). Bind the gesture directly instead — degraded (loses the
    // scroll fold for that prop) but safe. The decompose-order fix prevents this state.
    if (existing === combined || existing === mv) {
      newBindings[prop] = mv;
    } else {
      declLines.push(`  const ${combined} = useTransform([${existing}, ${mv}], ([s, h]) => s ${mult ? '*' : '+'} h);`);
      newBindings[prop] = combined;
    }
    startAnims.push(`animate(${mv}, ${target}, ${GESTURE_TRANS});`);
    endAnims.push(`animate(${mv}, ${rest}, ${GESTURE_TRANS});`);
  }

  // Insert decl lines before `return`.
  let result = code;
  const withHooks = insertBeforeRenderReturn(result, declLines.join('\n'));
  if (withHooks === null) return code;
  result = withHooks;

  // Rebuild the tag: drop the old gesture prop, keep any NON-conflicting props
  // declaratively, and add the gesture event handlers.
  const reGot = getOpeningTag(result, nodeId);
  if (!reGot) return code;
  // Strip the gesture prop in EITHER form (plain `={{…}}` or gated `={test ? {…} : …}`)
  // — brace-balanced so a nested object in the gated form doesn't terminate it early.
  let newTag = stripTagAttrBalanced(reGot.tag, cfg.whileProp);
  // Non-conflicting props stay declarative — re-emit in the SAME form (gated chain for a
  // responsive gesture, plain object otherwise) so a per-viewport non-scroll prop survives.
  const remainingProps = Object.keys(targets).filter((p) => !conflicts.includes(p));
  const handlerLines: string[] = [];
  if (remainingProps.length && gt) {
    if (gt.gated) {
      const objStr = (o: Record<string, string>) => {
        const f = Object.fromEntries(Object.entries(o).filter(([k]) => remainingProps.includes(k)));
        return Object.keys(f).length ? emitObj(f) : null;
      };
      let e = objStr(gt.baseObj) ?? 'undefined';
      for (let i = gt.ovParsed.length - 1; i >= 0; i--) e = `${gt.ovParsed[i].test} ? ${objStr(gt.ovParsed[i].obj) ?? 'undefined'} : ${e}`;
      handlerLines.push(`${cfg.whileProp}={${e}}`);
    } else {
      handlerLines.push(`${cfg.whileProp}={${emitObj(Object.fromEntries(remainingProps.map((p) => [p, gt.baseObj[p]])))}}`);
    }
  }
  handlerLines.push(`${cfg.startEv}={() => { ${startAnims.join(' ')} }}`);
  for (const ev of cfg.endEvs) handlerLines.push(`${ev}={() => { ${endAnims.join(' ')} }}`);
  newTag = newTag.replace(/^(<[a-zA-Z][\w.]*)/, `$1\n          ${handlerLines.join('\n          ')}`);
  result = result.slice(0, reGot.tagStart) + newTag + result.slice(reGot.gt);

  for (const [prop, v] of Object.entries(newBindings)) {
    result = injectStyleMotionBinding(result, nodeId, prop, v);
  }
  return result;
}

/** Inverse of composeGestureInCode — restore the declarative whileHover/whileTap
 *  and the property's original motion-value binding. */
export function decomposeGestureInCode(code: string, nodeId: string, kind: GestureKind): string {
  const cfg = GESTURES[kind];
  const cleanName = nodeIdToVarName(nodeId);
  const cn = escapeRegExp(cleanName);
  const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
  // Each composed prop: `<cn><Prop><Cap>C = useTransform([<existing>, <cn><Cap><Prop>], ([s, h]) => s OP h)`.
  const re = new RegExp(`const ${cn}(\\w+)${cfg.cap}C = useTransform\\(\\[(\\w+),\\s*${cn}${cfg.cap}\\w+\\],[^;]*\\);`, 'g');
  const matches = [...code.matchAll(re)];
  if (matches.length === 0) return code;

  let result = code;
  const restored: Record<string, string> = {};
  for (const m of matches) {
    const Prop = m[1], prop = lower(Prop), existing = m[2];
    const mv = `${cn}${cfg.cap}${Prop}`;
    // Recover the gesture target from the start handler: `animate(<mv>, <target>, …)`.
    const tm = result.match(new RegExp(`animate\\(${mv},\\s*([^,]+),`));
    if (tm) restored[prop] = tm[1].trim();
    // Restore the style binding to the original motion value, drop combined + MV.
    result = result.replace(new RegExp(`${prop}:\\s*${cn}${Prop}${cfg.cap}C`), `${prop}: ${existing}`);
    result = result.replace(new RegExp(`\\s*const ${cn}${Prop}${cfg.cap}C = useTransform\\([^;]*\\);`), '');
    result = result.replace(new RegExp(`\\s*const ${mv} = useMotionValue\\([^;]*\\);`), '');
  }
  // Remove the gesture event handlers + any still-declarative whileHover/whileTap
  // from the tag. stripJsxAttr is brace-aware — the handlers contain nested `{…}`
  // (the animate() spring config), which a `[^}]*` regex would mismatch.
  const got = getOpeningTag(result, nodeId);
  if (got) {
    let newTag = got.tag;
    const existingDecl = parseTagObject(newTag, cfg.whileProp) || {};
    for (const ev of [cfg.startEv, ...cfg.endEvs]) newTag = stripJsxAttr(newTag, ev);
    newTag = stripJsxAttr(newTag, cfg.whileProp);
    result = result.slice(0, got.tagStart) + newTag + result.slice(got.gt);

    // Reconstruct the (possibly RESPONSIVE) whileHover/whileTap from the recovered animate
    // targets. Each is plain ('1.05') OR a gated ternary ('(__mq0 ? 1.05 : 1)') that
    // composeGestureInCode emitted for a scoped gesture. Peel each into base + per-scope
    // overrides (parseScopedScalarExpr), drop neutral (= absent) values, then re-emit via
    // emitMotionPropResponsive (base object + `__mqN ? {…} : …` branches) — the exact
    // inverse of the gated compose. Without this, a scoped gesture's gated target was
    // re-quoted as a string and corrupted the tag (`motion.div__mq0`, `'''__mq0`).
    const baseProps: Record<string, string> = { ...existingDecl };
    const ovByScope = new Map<string, { scope: SerScope; props: Record<string, string> }>();
    for (const [prop, targetExpr] of Object.entries(restored)) {
      const rest = gestureRest(prop);
      const { base, responsive } = parseScopedScalarExpr(result, targetExpr);
      if (base.trim() !== rest) baseProps[prop] = base.trim();
      for (const r of responsive) {
        const key = scopeKey(r.scope);
        if (!ovByScope.has(key)) ovByScope.set(key, { scope: r.scope, props: {} });
        if (r.value.trim() !== rest) ovByScope.get(key)!.props[prop] = r.value.trim();
      }
    }
    const responsiveOv = [...ovByScope.values()].filter((o) => Object.keys(o.props).length);
    if (Object.keys(baseProps).length || responsiveOv.length) {
      result = emitMotionPropResponsive(result, nodeId, cfg.whileProp, baseProps, responsiveOv as FxScopeOverride[]);
    }
  }
  return result;
}


export { capProp, parseTagObject, effectParams, stripJsxAttr, composeScrollDirectionTransformInCode, GESTURES, GESTURE_TRANS, isStyleMotionVar, emitVal, emitObj, gestureRest };
