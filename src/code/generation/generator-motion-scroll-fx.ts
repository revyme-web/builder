// generator-motion-scroll-fx.ts — the ScrollFxSpec: parsing every scroll effect
// on a node into a compact spec, compose-all/decompose-all over a whole file, and
// the spec-driven regenerate path (setScrollFxInCode/getScrollFx) + scroll Speed.
// All code moved VERBATIM from generator-motion.ts (Phase 7.4 god-file split).
import { escapeRegExp } from '@/shared/regex-utils';
import { nodeIdToVarName } from '@/shared/id-utils';
import { parseScrollHooks, getScrollDataForNode, parseScrollDirection, parseRange } from '../parsing/scroll-parser';
import { trace } from '@/shared/debug-trace';
import { findTagClose, findJSXDataIdIndex, insertBeforeRenderReturn, findStyleObjectEnd, stripTagAttrBalanced, readTagAttrRaw, getJsonAttr } from './generator-utils';
import { setScrollVariantInCode } from './scroll-variant-gen';
import { setInstanceFxInCode } from './instance-fx-gen';
import { type ResolvedScope } from '@/code/animations/animation-scope';
import { scopeTest, scopeKey, buildScopedScalarExpr, parseScopedScalarExpr, type SerScope } from './scoped-expr';
import { findMotionPropExpr, parseScopedExpr, rebuildScopedExpr, readMotionPropResponsive, updateMotionPropInCode, setMotionPropScopedValue } from './generator-motion-props';
import { updateScrollAnimInCode, updateScrollDirectionAnimInCode, removeScrollDirectionFromCode, ensureMotionTag, type ScrollTrigger, type ScrollAnimConfig, type ScrollSpeedConfig } from './generator-motion-scroll';
import { parseTagObject, hasAppearTransformConflict, composeScrollAppearInCode, hasDirectionTransformConflict, composeScrollDirectionTransformInCode, hasGestureTransformConflict, composeGestureInCode, decomposeGestureInCode } from './generator-motion-compose';
import { LOOP_REPEAT_KEYS, getLoopAnimate, setLoopInCode, hasLoopConflict, composeLoopInCode, decomposeLoopInCode } from './generator-motion-loop';

/** A compact spec of every scroll effect on a node, parsed from the SEPARATE
 *  (editable) form. Emitted as `data-scroll-fx` on the COMBINED div so the panel
 *  can detect + edit each effect even though the rendered code is combined. */
// A serializable ResolvedScope override: per-breakpoint (`{query}`) or per-variant
// (`{variant}`) value for one motion prop. Mirrors the responsive ternary chain
// (`gate ? {override} : {base}`) the existing hover/tap system writes — captured into
// the spec so a regenerate (setScrollFxInCode) re-emits it instead of flattening to base.
// Scope uses the shared SerScope union (now incl. locale scopes — carried
// through parse/serialize verbatim; fx gating itself stays width/variant).
interface FxScopeOverride { scope: import('./scoped-expr').SerScope; props: Record<string, string> }

export interface ScrollFxSpec {
  appear?: { initial: Record<string, string>; once: boolean; transition?: Record<string, string>;
             /** per-viewport/variant overrides of the From (`initial`) state. */
             responsive?: FxScopeOverride[];
             /** Per-viewport/variant PRESENCE: tiles where the appear is turned OFF
              *  (the reference "remove here" on a replica). Codegen gates the From to
              *  `false` there (initial={false} = skip the enter animation). */
             hiddenOn?: SerScope[] };
  transform?: { trigger: string; from: Record<string, string>; to: Record<string, string>; transition?: Record<string, string>;
    /** Per-viewport/variant overrides of the From/To endpoints (base = from/to). Each
     *  prop's output range becomes `(<gate> ? [ovFrom, ovTo] : [from, to])`. */
    responsive?: Array<{ scope: SerScope; from?: Record<string, string>; to?: Record<string, string> }>;
    /** Per-viewport PRESENCE: the transform scrubs ONLY on these viewports; off-scope each
     *  numeric output collapses to its resting value (no scrub). Absent = everywhere. */
    scope?: SerScope[] };
  speed?: number;
  /** Per-viewport/variant Speed overrides (base = `speed`). */
  speedResponsive?: Array<{ scope: import('./scoped-expr').SerScope; speed: number }>;
  animation?: { direction: 'down' | 'up'; replay: boolean; toProps: Record<string, string>; transition?: Record<string, string>; scope?: SerScope[];
    responsive?: Array<{ scope: SerScope; direction?: 'down' | 'up'; replay?: boolean; toProps?: Record<string, string> }> };
  // Gestures composed into scroll motion values (a style MotionValue overrides a
  // declarative whileHover/whileTap on the same prop, so we fold them in). `props`
  // is the FULL gesture target (both composed + any still-declarative props) so the
  // popup edits normally; compose decides per-prop which need folding.
  hover?: { props: Record<string, string>; responsive?: FxScopeOverride[];
            /** Tiles where the hover is turned OFF (gates whileHover to `undefined`). */
            hiddenOn?: SerScope[] };
  tap?: { props: Record<string, string>; responsive?: FxScopeOverride[];
          /** Tiles where the tap is turned OFF (gates whileTap to `undefined`). */
          hiddenOn?: SerScope[] };
  loop?: { props: Record<string, string>; transition: Record<string, string>; offscreen?: string; scope?: SerScope[] };
}

/** Node's opening tag (without trailing `>`), brace-aware. */
export function getOpeningTag(code: string, nodeId: string): { tag: string; tagStart: number; gt: number } | null {
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return null;
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
  if (gt === -1) return null;
  return { tag: code.slice(tagStart, gt), tagStart, gt };
}

/** Parse all scroll effects on a node (from the SEPARATE form) into a spec. */
export function buildScrollFxSpec(code: string, nodeId: string): ScrollFxSpec {
  const spec: ScrollFxSpec = {};
  const tag = getOpeningTag(code, nodeId)?.tag ?? '';

  if (/whileInView=\{/.test(tag)) {
    // A loop shares the single `transition` prop, so strip its repeat keys — the
    // Appear must reveal once, never inherit `repeat: Infinity`.
    let transition = parseTagObject(tag, 'transition');
    if (transition && [...LOOP_REPEAT_KEYS, '__offscreen'].some(k => k in transition!)) {
      transition = Object.fromEntries(Object.entries(transition).filter(([k]) => !LOOP_REPEAT_KEYS.includes(k) && k !== '__offscreen'));
      if (!Object.keys(transition).length) transition = null;
    }
    const viewport = parseTagObject(tag, 'viewport');
    // The From (`initial`) state may be responsive (a `__mqN ? {…} : {…}` ternary).
    const initR = readMotionPropResponsive(code, nodeId, 'initial');
    spec.appear = { initial: initR?.base ?? parseTagObject(tag, 'initial') ?? {}, once: viewport?.once === 'true',
      ...(transition ? { transition } : {}), ...(initR?.responsive.length ? { responsive: initR.responsive } : {}),
      ...(initR?.hiddenOn.length ? { hiddenOn: initR.hiddenOn } : {}) };
  }

  const scroll = getScrollDataForNode(parseScrollHooks(code), nodeId);
  if (scroll.bindings.length > 0) {
    const from: Record<string, string> = {}, to: Record<string, string> = {};
    // Per-viewport overrides reconstructed from a GATED output range (the responsive
    // Scroll Transform). Grouped by scope so each viewport's [from, to] becomes one entry.
    const respByScope = new Map<string, { scope: SerScope; from: Record<string, string>; to: Record<string, string> }>();
    for (const b of scroll.bindings) {
      const t = scroll.transforms.find(tt => tt.varName === b.transformVar);
      if (!t) continue;
      const raw = (t.outputRange || '').trim();
      if (raw.startsWith('(')) {
        // Gated: `(test ? [ovFrom, ovTo] : [from, to])` — peel into base + per-scope arrays.
        const { base, responsive } = parseScopedScalarExpr(code, raw);
        const baseR = parseRange(base);
        if (baseR.length >= 2) { from[b.property] = baseR[0]; to[b.property] = baseR[baseR.length - 1]; }
        for (const r of responsive) {
          const rr = parseRange(r.value);
          if (rr.length < 2) continue;
          const key = scopeKey(r.scope);
          if (!respByScope.has(key)) respByScope.set(key, { scope: r.scope, from: {}, to: {} });
          const e = respByScope.get(key)!;
          e.from[b.property] = rr[0]; e.to[b.property] = rr[rr.length - 1];
        }
      } else {
        const out = parseRange(raw);
        if (out.length >= 2) { from[b.property] = out[0]; to[b.property] = out[out.length - 1]; }
      }
    }
    if (Object.keys(to).length) {
      spec.transform = { trigger: scroll.source?.refVar ? 'layerInView' : 'onScroll', from, to };
      const resp = [...respByScope.values()];
      if (resp.length) (spec.transform as { responsive?: unknown }).responsive = resp;
    }
  }

  const speedR = getSpeedResponsive(code, nodeId);
  if (speedR !== null) {
    spec.speed = speedR.base;
    if (speedR.responsive.length) spec.speedResponsive = speedR.responsive;
  }

  const dir = parseScrollDirection(code, nodeId);
  if (dir) spec.animation = { direction: dir.direction, replay: dir.replay, toProps: dir.toProps, ...(dir.transition ? { transition: dir.transition } : {}), ...(dir.scope?.length ? { scope: dir.scope as SerScope[] } : {}) };

  // Gestures may be responsive (a `__mqN ? {…} : {…}` ternary on whileHover/whileTap).
  const hoverR = readMotionPropResponsive(code, nodeId, 'whileHover');
  if (hoverR && (Object.keys(hoverR.base).length || hoverR.responsive.length))
    spec.hover = { props: hoverR.base, ...(hoverR.responsive.length ? { responsive: hoverR.responsive } : {}),
      ...(hoverR.hiddenOn.length ? { hiddenOn: hoverR.hiddenOn } : {}) };
  const tapR = readMotionPropResponsive(code, nodeId, 'whileTap');
  if (tapR && (Object.keys(tapR.base).length || tapR.responsive.length))
    spec.tap = { props: tapR.base, ...(tapR.responsive.length ? { responsive: tapR.responsive } : {}),
      ...(tapR.hiddenOn.length ? { hiddenOn: tapR.hiddenOn } : {}) };

  const loop = getLoopAnimate(code, nodeId);
  if (loop) spec.loop = { props: loop.props, transition: loop.trans, ...(loop.offscreen ? { offscreen: loop.offscreen } : {}), ...(loop.scope?.length ? { scope: loop.scope } : {}) };

  return spec;
}

/** Add/replace `data-scroll-fx='<json>'` on a node's opening tag. */
function injectScrollFxAttr(code: string, nodeId: string, spec: ScrollFxSpec): string {
  const result = code.replace(new RegExp(`\\s*data-scroll-fx='[^']*'`), '');
  const got = getOpeningTag(result, nodeId);
  if (!got) return result;
  const json = JSON.stringify(spec);   // double-quoted JSON inside a single-quoted JSX attr
  return result.slice(0, got.tagStart) +
    got.tag.replace(/^(<[a-zA-Z][\w.]*)/, `$1 data-scroll-fx='${json}'`) +
    result.slice(got.gt);
}

/** Compose EVERY Appear×Transform AND Direction×Transform conflict in a file, and
 *  ensure the imports the composed hooks need. The COMBINED div carries a
 *  `data-scroll-fx` spec so the panel still detects + edits each effect. No-op
 *  when there are no conflicts. */
export function composeAllScrollAppearConflicts(code: string): string {
  // Fast path: a compose needs ≥2 effects sharing something — a reveal
  // (`whileInView`/`animate=`), a gesture (`whileHover`/`whileTap`), or a loop. A
  // file with none of these drivers has nothing to combine. (Loop×appear/gesture
  // can conflict with NO scroll, so we no longer require `useScroll` here.)
  const hasDriver = code.includes('whileInView') || code.includes('animate=')
    || code.includes('whileHover') || code.includes('whileTap') || code.includes('data-loop=');
  if (!hasDriver) return code;
  const ids = [...new Set([...code.matchAll(/data-id="([^"]+)"/g)].map(m => m[1]))];
  let result = code;
  let composed = false;
  for (const id of ids) {
    const conflict = hasAppearTransformConflict(result, id) || hasDirectionTransformConflict(result, id)
      || hasGestureTransformConflict(result, id) || hasLoopConflict(result, id);
    if (!conflict) continue;
    // Capture the full effect spec from the SEPARATE form BEFORE combining,
    // then emit it as data-scroll-fx on the combined div so the panel can still
    // detect + edit each effect.
    const spec = buildScrollFxSpec(result, id);
    // Capture the loop BEFORE the appear compose strips the shared `transition`
    // (which holds the loop's repeat config).
    const loopData = getLoopAnimate(result, id);
    if (hasAppearTransformConflict(result, id)) result = composeScrollAppearInCode(result, id);
    if (hasDirectionTransformConflict(result, id)) result = composeScrollDirectionTransformInCode(result, id);
    // Loop composes after the reveal (so its repeat transition is separate from the
    // appear's) and BEFORE gestures (so a hover/tap on the same prop folds over the
    // loop's motion value).
    result = composeLoopInCode(result, id, loopData);
    // Gestures compose LAST so they wrap the final motion value for each shared prop.
    result = composeGestureInCode(result, id, 'hover');
    result = composeGestureInCode(result, id, 'tap');
    result = injectScrollFxAttr(result, id, spec);
    composed = true;
  }
  if (!composed) return code;
  // Ensure framer-motion imports the composed hooks (useInView, useMotionValue, animate).
  for (const hook of ['useInView', 'useMotionValue', 'animate']) {
    if (new RegExp(`\\b${hook}\\b`).test(result) && !new RegExp(`import[^;]*\\b${hook}\\b[^;]*from\\s*['"]framer-motion['"]`).test(result)) {
      result = result.replace(/(import\s*\{)([^}]*)(\}\s*from\s*['"]framer-motion['"])/, (_m, a, b, c) => `${a}${b}, ${hook}${c}`);
    }
  }
  // Ensure react imports the composed hooks (useRef, useEffect).
  for (const hook of ['useRef', 'useEffect']) {
    if (new RegExp(`\\b${hook}\\b`).test(result) && !new RegExp(`import[^;]*\\b${hook}\\b[^;]*from\\s*['"]react['"]`).test(result)) {
      if (/import\s+React\s*,\s*\{[^}]*\}\s*from\s*['"]react['"]/.test(result)) {
        result = result.replace(/(import\s+React\s*,\s*\{)([^}]*)(\}\s*from\s*['"]react['"])/, (_m, a, b, c) => `${a}${b}, ${hook}${c}`);
      } else if (/import\s*\{[^}]*\}\s*from\s*['"]react['"]/.test(result)) {
        result = result.replace(/(import\s*\{)([^}]*)(\}\s*from\s*['"]react['"])/, (_m, a, b, c) => `${a}${b}, ${hook}${c}`);
      } else if (/import\s+React\s+from\s*['"]react['"]/.test(result)) {
        result = result.replace(/import\s+React\s+from\s*['"]react['"]/, `import React, { ${hook} } from 'react'`);
      }
    }
  }
  return result;
}

/** Inject extra attributes into a node's opening tag, right before its `>`. */
function injectAttrsBeforeClose(code: string, nodeId: string, attrs: string[]): string {
  if (attrs.length === 0) return code;
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return code;
  const tagStart = code.lastIndexOf('<', idIdx);
  let gt = -1, depth = 0, inStr = '';
  for (let i = tagStart; i < code.length; i++) {
    const ch = code[i];
    if (inStr) { if (ch === inStr) inStr = ''; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    else if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && depth === 0) { gt = i; break; }
  }
  if (gt === -1) return code;
  const selfClose = code[gt - 1] === '/';
  const insertAt = selfClose ? gt - 1 : gt;
  return code.slice(0, insertAt) + `\n          ${attrs.join('\n          ')}\n          ` + code.slice(insertAt);
}

/** Inverse of composeScrollDirectionTransformInCode: turn the combined motion
 *  values back into the separate `animate={…}` + scrubbed `style` binding. Used
 *  so the editor's parsers/generators always see the un-combined (editable) form;
 *  the stored source is re-combined on write. No-op if the node isn't combined. */
export function decomposeScrollDirectionTransformInCode(code: string, nodeId: string): string {
  const cleanName = nodeIdToVarName(nodeId);
  const cn = escapeRegExp(cleanName);
  const condVar = `${cleanName}Scrolled`;

  const animRe = new RegExp(`\\bconst (${cn}Anim(\\w+)) = useMotionValue\\(([^)]+)\\);`, 'g');
  const props: { animVar: string; Prop: string; resting: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = animRe.exec(code))) props.push({ animVar: m[1], Prop: m[2], resting: m[3].trim() });
  if (props.length === 0) return code;

  let result = code;
  const active: Record<string, string> = {};
  const restingMap: Record<string, string> = {};
  let transition = `{ type: 'spring', duration: 0.5, bounce: 0.25 }`;

  for (const { animVar, Prop, resting } of props) {
    const prop = Prop.charAt(0).toLowerCase() + Prop.slice(1);
    const av = escapeRegExp(animVar);
    // Tolerate REFORMATTED code: an AST-path mutation (updateStyles, etc.) runs babel
    // `generate` on the whole page, turning this single-line useEffect multi-line. Use
    // `\s*` between tokens + `[\s\S]*?` for the transition object so the match survives.
    const effRe = new RegExp(`\\s*useEffect\\(\\(\\)\\s*=>\\s*\\{\\s*const _c = animate\\(${av},\\s*${cn}Scrolled\\s*\\?\\s*([\\s\\S]+?)\\s*:\\s*[\\s\\S]+?,\\s*(\\{[\\s\\S]*?\\})\\);\\s*return \\(\\)\\s*=>\\s*_c\\.stop\\(\\);\\s*\\},\\s*\\[${cn}Scrolled\\]\\);`);
    const em = result.match(effRe);
    active[prop] = em ? em[1].trim() : '0';
    if (em) transition = em[2].trim();
    restingMap[prop] = resting;
    const dcRe = new RegExp(`\\s*const ${cn}${Prop}DC = useTransform\\(\\[${av},\\s*(\\w+)\\][^;]*\\);`);
    const dm = result.match(dcRe);
    if (dm) {
      result = result.replace(new RegExp(`${prop}:\\s*${cn}${Prop}DC`), `${prop}: ${dm[1]}`);
      result = result.replace(dcRe, '');
    }
    result = result.replace(new RegExp(`\\s*const ${av} = useMotionValue\\([^)]+\\);`), '');
    result = result.replace(effRe, '');
  }

  const fmt = (o: Record<string, string>) => `{ ${Object.entries(o).map(([k, v]) => `${k}: ${v}`).join(', ')} }`;
  result = injectAttrsBeforeClose(result, nodeId, [
    `animate={${condVar} ? ${fmt(active)} : ${fmt(restingMap)}}`,
    `transition={${transition}}`,
  ]);
  return result;
}

/** Inverse of composeScrollAppearInCode: combined appear motion values back to
 *  the editable `initial`/`whileInView`/`viewport` + scrubbed style binding. */
export function decomposeScrollAppearInCode(code: string, nodeId: string): string {
  const cleanName = nodeIdToVarName(nodeId);
  const cn = escapeRegExp(cleanName);
  if (!new RegExp(`\\bconst ${cn}Appear = useMotionValue\\(0\\);`).test(code)) return code;
  let result = code;
  const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

  // Whitespace-tolerant: an AST-path mutation reformats these hooks
  // multi-line (`{\n once: true\n }`) — exact-spacing patterns miss them.
  const onceM = result.match(new RegExp(`useInView\\(${cn}Ref,\\s*\\{\\s*once:\\s*(true|false)\\s*\\}`));
  const once = onceM ? onceM[1] : 'true';
  const transM = result.match(new RegExp(`animate\\(${cn}Appear,\\s*1,\\s*(\\{[^}]*\\})\\)`));
  const transition = transM ? transM[1].trim() : null;

  const initial: Record<string, string> = {};
  const whileInView: Record<string, string> = {};

  // Shared props (×): `<cn><Prop>C = useTransform([<cn>Appear, <transformVar>], …)`.
  for (const cm of [...result.matchAll(new RegExp(`const ${cn}(\\w+)C = useTransform\\(\\[${cn}Appear,\\s*(\\w+)\\][^;]*\\);`, 'g'))]) {
    const Prop = cm[1], prop = lower(Prop), tv = cm[2];
    initial[prop] = '0'; whileInView[prop] = '1';   // standard 0→1 reveal
    result = result.replace(new RegExp(`${prop}:\\s*${cn}${Prop}C`), `${prop}: ${tv}`);
    result = result.replace(new RegExp(`\\s*const ${cn}${Prop}C = useTransform\\(\\[${cn}Appear,\\s*${tv}\\][^;]*\\);`), '');
  }
  // Appear + sibling-effect props (e.g. Scroll Speed parallax):
  // `<cn><Prop>AC = useTransform([<cn><Prop>A, <siblingVar>], …)`. Restore the
  // style binding to the sibling var and drop the AC line; the `<cn><Prop>A`
  // line is left for the appear-only loop below (it recovers initial/resting).
  for (const cm of [...result.matchAll(new RegExp(`const ${cn}(\\w+)AC = useTransform\\(\\[${cn}\\w+A,\\s*(\\w+)\\][^;]*\\);`, 'g'))]) {
    const Prop = cm[1], prop = lower(Prop), sibling = cm[2];
    result = result.replace(new RegExp(`${prop}:\\s*${cn}${Prop}AC`), `${prop}: ${sibling}`);
    result = result.replace(new RegExp(`\\s*const ${cn}${Prop}AC = useTransform\\(\\[${cn}\\w+A,\\s*${sibling}\\][^;]*\\);`), '');
  }
  // Appear-only props: `<cn><Prop>A = useTransform(<cn>Appear, [0, 1], [init, rest])`.
  for (const am of [...result.matchAll(new RegExp(`const ${cn}(\\w+)A = useTransform\\(${cn}Appear,\\s*\\[0, 1\\],\\s*\\[([^,]+),\\s*([^\\]]+)\\]\\);`, 'g'))]) {
    const Prop = am[1], prop = lower(Prop);
    initial[prop] = am[2].trim(); whileInView[prop] = am[3].trim();
    result = result.replace(new RegExp(`,?\\s*${prop}:\\s*${cn}${Prop}A`), '');
    result = result.replace(new RegExp(`\\s*const ${cn}${Prop}A = useTransform\\(${cn}Appear,[^;]*\\);`), '');
  }

  result = result
    .replace(new RegExp(`\\s*const ${cn}Ref = useRef\\(null\\);`), '')
    .replace(new RegExp(`\\s*const ${cn}InView = useInView\\([^;]*\\);`), '')
    .replace(new RegExp(`\\s*const ${cn}Appear = useMotionValue\\(0\\);`), '')
    // Whitespace-tolerant effect match — the single-line-only form
    // (`{ if (` / `}, [` with exact spaces) missed the MULTI-LINE effect an
    // AST-path mutation reformats to, so decompose removed the InView/Appear
    // DECLS but left the effect referencing them: deleting the section then
    // failed validation with "References undefined identifiers …InView,
    // …Appear" ("can't delete the whole page", 2026-08-07).
    .replace(new RegExp(`\\s*useEffect\\(\\(\\)\\s*=>\\s*\\{\\s*if\\s*\\(${cn}InView\\)[\\s\\S]*?\\},\\s*\\[${cn}InView\\]\\);`), '')
    .replace(new RegExp(`\\s*ref=\\{${cn}Ref\\}`), '');

  // A loop decomposes first and restores the shared `transition` (with its repeat
  // keys); the appear's transition is the repeat-stripped subset of that, so skip
  // it when one is already present — never emit a duplicate `transition` attr.
  const tagHasTransition = /\btransition=\{/.test(getOpeningTag(result, nodeId)?.tag ?? '');
  const fmt = (o: Record<string, string>) => `{ ${Object.entries(o).map(([k, v]) => `${k}: ${v}`).join(', ')} }`;
  result = injectAttrsBeforeClose(result, nodeId, [
    `initial={${fmt(initial)}}`,
    `whileInView={${fmt(whileInView)}}`,
    `viewport={{ once: ${once} }}`,
    ...(transition && !tagHasTransition ? [`transition={${transition}}`] : []),
  ]);
  return result;
}

/** De-combine EVERY combined scroll conflict in a file — the inverse of
 *  composeAllScrollAppearConflicts. Returns the editable (separate) view the
 *  editor's parsers/generators operate on. No-op if nothing is combined. */
export function decomposeAllScrollConflicts(code: string): string {
  // Fast path: combined forms always declare a `… = useMotionValue(` reveal.
  if (!code.includes('= useMotionValue(')) return code;
  const ids = [...new Set([...code.matchAll(/data-id="([^"]+)"/g)].map(m => m[1]))];
  let result = code;
  for (const id of ids) {
    // Decompose in REVERSE compose order (outermost first). Compose runs hover THEN
    // tap, so tap is the outer wrapper when both fold the SAME prop (scale) — it must
    // decompose FIRST, else hover-first can't find its binding (style holds the tap
    // var) and the chain collapses into a self-referential useTransform → crash.
    result = decomposeGestureInCode(result, id, 'tap');
    result = decomposeGestureInCode(result, id, 'hover');
    result = decomposeLoopInCode(result, id);
    result = decomposeScrollDirectionTransformInCode(result, id);
    result = decomposeScrollAppearInCode(result, id);
  }
  // The combined form carried the editable spec in data-scroll-fx; the separate
  // form re-derives detection from the live JSX, so drop the now-stale attr.
  // (recompose re-emits a fresh one for any node that's still conflicting.)
  result = result.replace(/\s*data-scroll-fx='[^']*'/g, '');
  return result;
}

/** Remove EVERY scroll/motion artifact a single node owns — used by node deletion
 *  so the composed machinery (appear / loop / gesture reveal hooks) and scroll hooks
 *  don't dangle in the body once the JSX element is gone. Safe no-op for plain nodes. */
export function clearNodeScrollFx(code: string, nodeId: string): string {
  // Cheap top-level bail: every artifact stripped below — scroll-variant `<cn>Sv`,
  // instance-fx, decomposed gesture/loop/scroll hooks, and the const sweep in step 3 —
  // is keyed by the node's sanitized name `cn`. If `cn` doesn't even appear in the
  // source, the node has no scroll/motion fx and there's nothing to strip, so skip the
  // dozen full-page regex sweeps. (instance-fx-gen's `cleanNameOf` uses the IDENTICAL
  // sanitizer, so this single check covers every sub-stripper; a substring collision
  // with another node's name only causes a harmless extra run, never a wrong skip.)
  // This was the dominant per-node cost of multi-delete (~22ms × N), all of it wasted
  // on plain frames that never had any animation.
  const cn = nodeIdToVarName(nodeId);
  if (!code.includes(cn)) return code;
  let result = code;
  const clearProtectRef = textAnimSharesNodeRef(code, escapeRegExp(cn));
  // 0. Scroll Variant is a SEPARATE page-level system (useScroll/useInView + a
  //    MULTI-LINE useMotionValueEvent handler + `const <cn>Sv…` decls + bound attrs).
  //    Its handler is not a `const` decl, so the const-only sweep in step 3 would drop
  //    the decls but leave the handler dangling on now-undefined ids. Strip it fully
  //    here. No-op for nodes without a variant.
  result = setScrollVariantInCode(result, nodeId, null);
  // 0b. Component-instance effects (instance-fx) — page-level motion values + motion
  //     hover()/press() useEffects + the shared ref, bound to the instance style. Same
  //     deal: strip the whole block or its multi-line handlers dangle after the JSX
  //     element is gone. No-op for non-instance nodes.
  result = setInstanceFxInCode(result, nodeId, null);
  // 1. De-combine: unwind composed appear/loop/gesture/direction machinery (incl.
  //    the multi-line useMotionValueEvent) back to the separate declarative form so
  //    the per-effect removers below can recognise + strip the scroll hooks.
  result = decomposeGestureInCode(result, nodeId, 'tap');
  result = decomposeGestureInCode(result, nodeId, 'hover');
  result = decomposeLoopInCode(result, nodeId);
  result = decomposeScrollDirectionTransformInCode(result, nodeId);
  result = decomposeScrollAppearInCode(result, nodeId);
  // 2. Remove the separate-form scroll hooks (transform / speed / direction).
  result = removeScrollSpeedFromCode(result, nodeId);
  result = removeScrollDirectionFromCode(result, nodeId);
  result = removeScrollAnimFromCode(result, nodeId);
  // 3. Safety net: drop any leftover single-line `const <cn>X = …` declarations /
  //    destructures / useState the steps above didn't claim (e.g. a loop-created
  //    ref, a stray useMotionValue). `<cn>` + an uppercase initial avoids matching
  //    a DIFFERENT node that merely shares this one's name as a prefix.
  const e = escapeRegExp(cn);
  // 3a. MULTI-LINE handlers a stale/secondary block leaves behind that the line filter below can't reach.
  //     Real case: an orphaned scroll-variant block from an older codegen (`<cn>BarSv…`: a
  //     `useMotionValueEvent(<cn>…ScrollY, …)` + a `useEffect(() => { <cn>…Ref.current = … }, [])`). The
  //     `[A-Z]` guard does NOT exclude it — a sibling whose cleanName EXTENDS this one in PascalCase
  //     (`HeaderMqebrhuj_29` vs `HeaderMqebrhuj_29Bar`) still starts with an uppercase initial — so the
  //     filter drops its `const` decls while these multi-line handlers survive → they reference the
  //     now-removed consts → "References undefined identifier …Ref/set… — would crash" on the next validate
  //     (exactly the Header-delete failure). Strip them here so the const removal is COMPLETE, not partial.
  //     The useEffect anchors the ref right after `{` (no leading `[\s\S]*?`) so it can't leak into a
  //     neighbouring unrelated effect.
  result = result.replace(new RegExp(`\\s*useMotionValueEvent\\(${e}(?!${TEXT_ANIM_TAIL})[A-Z]\\w*[\\s\\S]*?\\}\\);`, 'g'), '');
  result = result.replace(new RegExp(`\\s*useEffect\\(\\(\\)\\s*=>\\s*\\{\\s*${e}(?!${TEXT_ANIM_TAIL})[A-Z]\\w*Ref\\.current[^;]*;\\s*\\}\\s*,\\s*\\[[^\\]]*\\]\\);`, 'g'), '');
  //     The appear-reveal effect (`useEffect(() => { if (<cn>InView) { animate(<cn>Appear…`)
  //     when decompose's own removal missed it (e.g. a partially-stripped legacy block whose
  //     Appear decl is already gone, so decompose's gate never ran). Both anchors carry the
  //     node's own name, so the lazy middle can't swallow a neighbouring effect.
  result = result.replace(new RegExp(`\\s*useEffect\\(\\(\\)\\s*=>\\s*\\{\\s*if\\s*\\(${e}(?!${TEXT_ANIM_TAIL})[A-Z]\\w*\\)[\\s\\S]*?\\},\\s*\\[${e}(?!${TEXT_ANIM_TAIL})[A-Z]\\w*\\]\\);`, 'g'), '');
  result = result.split('\n').filter((line) => {
    const t = line.trim();
    // A line that OPENS a multi-line block (ends with `{`) is NOT a single-line
    // declaration — dropping only its first line orphans the body. The node's
    // variant object `const <cn>Variants = {` matches the `[A-Z]\w*` pattern below
    // (the uppercase `V`), so without this guard deleting e.g. `nl2` would strip
    // `const nl2Variants = {` and leave `default: {…}, …};` dangling (a syntax
    // error → "AI changes blocked"). Variant objects are removed wholesale by
    // removeOrphanedVariantConsts; leave block openers alone here.
    if (t.endsWith('{')) return true;
    const fx = `${e}(?!${TEXT_ANIM_TAIL})[A-Z]`;
    const protectedRef = clearProtectRef && new RegExp(`^const ${e}Ref\\s*=`).test(t);
    if (protectedRef) return true;
    if (new RegExp(`^const ${fx}\\w*\\s*=`).test(t)) return false;              // const cnXxx = …
    if (new RegExp(`^const \\{[^}]*:\\s*${fx}\\w*\\s*\\}\\s*=`).test(t)) return false; // const { k: cnXxx } = …
    if (new RegExp(`^const \\[\\s*${fx}\\w*`).test(t)) return false;            // const [cnXxx, …] = useState
    if (/^useEffect\(/.test(t) && new RegExp(`\\b${fx}\\w*`).test(t) && /\);$/.test(t)) return false; // single-line useEffect
    return true;
  }).join('\n');
  return result;
}

// ── Spec-driven scroll-fx (Phase 1) ──────────────────────────────────────────
// The data-scroll-fx system is regex-decompose/compose based, which is fragile to
// reformatting (an AST-path mutation runs babel `generate` on the whole page, turning
// the single-line hooks multi-line → regexes miss them → orphaned vars / duplicate
// hooks). The robust model — same as instance-fx — is to treat `data-scroll-fx` as the
// single source of truth and REGENERATE the node's whole hook block from it on every
// change: robustClearScrollFx wipes everything (format-tolerant), then re-emit the
// separate forms from the spec + compose. No decompose-in-place, so no fragility.

// ── Text-anim hook carve-out ─────────────────────────────────────────────────
// data-text-anim (text-anim-gen.ts) generates PER-LETTER hooks that share the
// node's `<cn>` prefix: `<cn>TeSP`/`<cn>TaSP` (useScroll progress), `<cn>TeRef`
// (querySelector ref) and `<cn>Te<N>Opacity`/`<cn>Te<N>Y` (letter transforms).
// They are NOT scroll-fx vars — the JSX letter spans keep referencing them
// after a scroll-fx removal (removeTextAnim owns their lifecycle). The
// `<cn>[A-Z]` sweeps below must never claim them, or removing the Scroll
// Transform from a node that ALSO has a character text-anim deletes the
// consts and leaves 2-per-letter dangling identifiers (live find 2026-07-13:
// "approachTitleTe0Opacity … +92 more — would crash" blocked the removal).
// Same carve-out precedent as `<cn>Variants` in removeScrollFxConst.
const TEXT_ANIM_TAIL = 'T[ea](?:\\d|SP\\b|Ref\\b)';

/** `<cn><Uppercase>` matcher that skips the text-anim hook family. */
function scrollFxVarRe(e: string): RegExp {
  return new RegExp(`${e}(?!${TEXT_ANIM_TAIL})[A-Z]`);
}

/** True when the node's TEXT-ANIM hooks read the node's `<cn>Ref` as their
 *  useScroll target. Generated text-anims own a separate `<cn>TeRef`, but
 *  hand-edited/migrated files can point `<cn>T[ea]SP`'s useScroll at the
 *  scroll-fx ref — the removal must then PRESERVE the ref const + `ref={}`
 *  attr or the surviving text-anim hooks dangle on an undefined ref. */
function textAnimSharesNodeRef(code: string, e: string): boolean {
  const useScrollRe = new RegExp(`useScroll\\(\\{[^)]*?target:\\s*${e}Ref\\b`, 'g');
  const spHeadRe = new RegExp(`${e}T[ea]SP`);
  let m: RegExpExecArray | null;
  while ((m = useScrollRe.exec(code)) !== null) {
    const head = code.slice(Math.max(0, m.index - 160), m.index);
    if (spHeadRe.test(head)) return true;
  }
  return false;
}

/** Remove every top-level `const …;` whose binding references `<cn>[A-Z]` (a scroll-fx
 *  var), to the depth-0 `;` — balanced over parens/braces/brackets + string-aware, so it
 *  removes the WHOLE multi-line decl (`const cnSmooth = useSpring(…\n …\n});`), not just
 *  the first line. Run AFTER the useEffect/useMotionValueEvent removal (their inner
 *  `const _c` is already gone). */
function removeScrollFxConst(code: string, e: string, protectRef = false): string {
  const refRe = scrollFxVarRe(e);
  const nodeRefRe = new RegExp(`\\b${e}Ref\\b`);
  let result = code, from = 0;
  while (true) {
    const idx = result.indexOf('const ', from);
    if (idx === -1) break;
    let depth = 0, inStr = '', end = -1;
    for (let i = idx + 6; i < result.length; i++) {
      const ch = result[i];
      if (inStr) { if (ch === inStr) inStr = ''; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
      else if (ch === '(' || ch === '{' || ch === '[') depth++;
      else if (ch === ')' || ch === '}' || ch === ']') depth--;
      else if (ch === ';' && depth === 0) { end = i; break; }
    }
    if (end === -1) { from = idx + 6; continue; }
    const stmt = result.slice(idx, end + 1);
    const head = stmt.slice(0, stmt.indexOf('=') === -1 ? stmt.length : stmt.indexOf('='));
    // A framer-motion variants object ALSO starts with `<cn>[A-Z]` (Variants →
    // 'V') but is NOT a scroll-fx var. Deleting one leaves the JSX's
    // `variants={…}` referencing an undefined identifier — the reported
    // "frameMr2ed4ynBVariants — would crash at runtime" when removing the Appear
    // effect from a component-master root.
    //
    // Matching only `<cn>Variants` was too narrow. A component names its CHILD
    // variant objects `<childCn>Variants`, and a child's cn carries the parent's
    // prefix — so removing the Scroll Transform from a nav root (`e` = 'nav')
    // swept navBarVariants / navMarkVariants / navLinksVariants / navCtaVariants
    // / navBurgerVariants / navBarTopVariants / navBarBottomVariants and left
    // seven dangling identifiers (live find 2026-08-02). Every one of them
    // matches `nav[A-Z]`; only the exact `navVariants` was carved out.
    //
    // Any binding whose name ends in `Variants` is a variants object — a
    // scroll-fx var is never named that — so protect the whole family.
    const isVariantsConst = /\b\w*Variants\b/.test(head);
    // Shared-ref protection: text-anim still targets `<cn>Ref` — keep it.
    const isProtectedRef = protectRef && nodeRefRe.test(head);
    if (refRe.test(head) && !isVariantsConst && !isProtectedRef) {
      let start = idx;
      while (start > 0 && (result[start - 1] === ' ' || result[start - 1] === '\t')) start--;
      if (result[start - 1] === '\n') start--;
      result = result.slice(0, start) + result.slice(end + 1);
      from = start;
    } else from = end + 1;
  }
  return result;
}

/** Remove every top-level `name(…);` whose paren-balanced span references `<cn>[A-Z]`
 *  (one of this node's scroll-fx vars). Paren/string-aware → survives reformatting. */
function removeScrollFxCall(code: string, name: string, e: string): string {
  const refRe = scrollFxVarRe(e);
  let result = code, from = 0;
  while (true) {
    const idx = result.indexOf(`${name}(`, from);
    if (idx === -1) break;
    let depth = 0, inStr = '', end = -1;
    for (let i = idx + name.length; i < result.length; i++) {
      const ch = result[i];
      if (inStr) { if (ch === inStr) inStr = ''; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
      else if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) { from = idx + name.length; continue; }
    let semi = end + 1;
    while (semi < result.length && /[ \t]/.test(result[semi])) semi++;
    if (result[semi] === ';') semi++;
    if (refRe.test(result.slice(idx, semi))) {
      let start = idx;
      while (start > 0 && (result[start - 1] === ' ' || result[start - 1] === '\t')) start--;
      if (result[start - 1] === '\n') start--;
      result = result.slice(0, start) + result.slice(semi);
      from = start;
    } else from = semi;
  }
  return result;
}

/** Format-tolerant wipe of ALL of a node's data-scroll-fx machinery: the tag's effect
 *  attrs + style motion-value bindings + ref, and every `<cn>…` decl/handler. Robust to
 *  reformatting AND duplicate corruption (it removes everything, not just one form). */
/** Motion gesture props that the VARIANT CONNECTION graph also writes. */
const CONNECTION_HANDLER_ATTRS = new Set([
  'onHoverStart', 'onHoverEnd', 'onTapStart', 'onTap', 'onTapCancel',
]);

/** True when this handler drives the variant state machine — i.e. it belongs to
 *  a connection (`onTap={() => … setVariant(_n) …}`), not to the scroll-fx
 *  effect being cleared. Scroll-fx handlers move motion values instead and
 *  never call setVariant. */
function handlerDrivesVariants(tag: string, attr: string): boolean {
  const raw = readTagAttrRaw(tag, attr);
  return !!raw && /\bsetVariant\s*\(/.test(raw);
}

export function robustClearScrollFx(code: string, nodeId: string): string {
  const cn = nodeIdToVarName(nodeId);
  const e = escapeRegExp(cn);
  let result = code;
  const protectRef = textAnimSharesNodeRef(result, e);
  const got = getOpeningTag(result, nodeId);
  if (got) {
    let tag = got.tag;
    // On a component-VARIANT node, `animate={['default', …]}` (list form) and the
    // `initial` list are VARIANT wiring — NOT appear/scroll props. Stripping them
    // kills the variant system (and, with the const preserved above, leaves a
    // `variants` object that never activates). Keep the variant `animate` list and
    // restore `initial` to match (Appear had overwritten `initial` with an object
    // from-state). A scroll ANIMATION's object-form `animate={{…}}` is still stripped.
    const keepVariantAnimate = /\bvariants=\{/.test(tag) && /\banimate=\{\[[^\]]*\]\}/.test(tag);
    const attrs = ['data-scroll-fx', 'whileHover', 'whileTap', 'onHoverStart', 'onHoverEnd',
      'onTapStart', 'onTap', 'onTapCancel', 'initial', 'whileInView', 'viewport', 'transition'];
    if (!keepVariantAnimate) attrs.push('animate');
    for (const a of attrs) {
      // The gesture handlers are in this list because a scroll-fx effect can
      // emit its own. But VARIANT CONNECTIONS use the very same prop names, and
      // those are a different feature entirely — clearing an Appear off a
      // connected component silently deleted its onTap/onHoverStart, so the
      // interactions stopped working (user report 2026-08-09). A connection
      // handler is the one that drives the variant state; leave it alone.
      if (CONNECTION_HANDLER_ATTRS.has(a) && handlerDrivesVariants(tag, a)) continue;
      tag = stripTagAttrBalanced(tag, a);
    }
    if (keepVariantAnimate) {
      // Re-establish the variant `initial` the Appear effect had replaced.
      tag = tag.replace(/(data-id="[^"]*")/, `$1 initial={['default', initialVariant]}`);
    }
    if (!protectRef) {
      tag = tag.replace(new RegExp(`\\s*ref=\\{${e}\\w*\\}`), '');
    }
    // Drop style props bound to one of this node's scroll-fx vars (<cn>X…).
    tag = tag.replace(/style=\{\{([\s\S]*?)\}\}/, (_m, inner: string) => {
      const kept = inner.split(',').filter((part) => {
        const pm = part.match(/^\s*\w+\s*:\s*([A-Za-z_$][\w$]*)\s*$/);
        return !(pm && new RegExp(`^${e}(?!${TEXT_ANIM_TAIL})[A-Z]`).test(pm[1]));
      }).map((s) => s.trim()).filter(Boolean);
      return kept.length ? `style={{ ${kept.join(', ')} }}` : '';
    });
    result = result.slice(0, got.tagStart) + tag + result.slice(got.gt);
  }
  // Handlers first (their inner `const _c` goes with them), then the balanced const sweep
  // — both format-tolerant (multi-line safe), unlike a per-line filter.
  result = removeScrollFxCall(result, 'useEffect', e);
  result = removeScrollFxCall(result, 'useMotionValueEvent', e);
  result = removeScrollFxConst(result, e, protectRef);
  return result;
}

/** Read a node's data-scroll-fx spec — the `data-scroll-fx` attr (composed nodes) or,
 *  failing that, reconstructed from the separate form. The source of truth for the
 *  spec-driven regenerate. */
export function getScrollFx(code: string, nodeId: string): ScrollFxSpec | null {
  if (!getOpeningTag(code, nodeId)) return null;
  const spec = getJsonAttr<ScrollFxSpec>(code, nodeId, 'data-scroll-fx');
  if (spec) return spec;
  const built = buildScrollFxSpec(code, nodeId);
  return Object.keys(built).length ? built : null;
}

const restingOf = (initial: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.keys(initial).map((k) => [k, (k === 'opacity' || k === 'scale') ? '1' : '0']));

/** Re-emit a motion prop WITH its responsive overrides (the regenerate side of the
 *  per-scope spec). Writes the base first, then folds each override branch back via
 *  `setMotionPropScopedValue` (re-creating the `__mqN ? {override} : {base}` ternary +
 *  its useMediaQuery gate). A base-less effect (scoped-only) skips the base write and
 *  lets the first scoped write create the prop with an `undefined` tail. */
function emitMotionPropResponsive(
  code: string, nodeId: string, propName: string,
  base: Record<string, string>, responsive?: FxScopeOverride[],
): string {
  if (base && Object.keys(base).length) code = updateMotionPropInCode(code, nodeId, propName, base);
  for (const ov of responsive ?? []) code = setMotionPropScopedValue(code, nodeId, propName, ov.props, ov.scope as ResolvedScope);
  return code;
}

/** PRESENCE gate for a motion prop: on each `hiddenOn` scope the prop collapses to
 *  the `off` sentinel — `false` for `initial` (motion skips the enter animation),
 *  `undefined` for whileHover/whileTap (gesture removed there). The reference
 *  "remove here on a replica" model for normal motion.* nodes. */
function gateMotionPropHidden(
  code: string, nodeId: string, propName: string,
  hiddenOn: SerScope[], off: 'false' | 'undefined',
): string {
  for (const s of hiddenOn) {
    const t = scopeTest(code, s as ResolvedScope); code = t.code;
    if (!t.test) continue;
    const e = findMotionPropExpr(code, nodeId, propName);
    if (!e) return code;
    const { base, overrides } = parseScopedExpr(code.slice(e.start, e.end));
    overrides.set(t.test, off);
    code = code.slice(0, e.start) + rebuildScopedExpr(base, overrides) + code.slice(e.end);
  }
  return code;
}

/** Set/replace/remove (`spec=null`) a node's ENTIRE data-scroll-fx suite by clearing and
 *  regenerating from the spec (re-emit separate forms → compose). Source of truth = the
 *  spec, so it's reformat-proof and self-healing (wipes any prior corruption). */
export function setScrollFxInCode(code: string, nodeId: string, spec: ScrollFxSpec | null): string {
  trace.fn('generator.setScrollFx', { nodeId, effects: spec ? Object.keys(spec) : 'remove' });
  let result = robustClearScrollFx(code, nodeId);
  if (!spec || !Object.keys(spec).length) return result;
  if (spec.hover) {
    result = emitMotionPropResponsive(result, nodeId, 'whileHover', spec.hover.props, spec.hover.responsive);
    if (spec.hover.hiddenOn?.length) result = gateMotionPropHidden(result, nodeId, 'whileHover', spec.hover.hiddenOn, 'undefined');
  }
  if (spec.tap) {
    result = emitMotionPropResponsive(result, nodeId, 'whileTap', spec.tap.props, spec.tap.responsive);
    if (spec.tap.hiddenOn?.length) result = gateMotionPropHidden(result, nodeId, 'whileTap', spec.tap.hiddenOn, 'undefined');
  }
  if (spec.appear) {
    result = emitMotionPropResponsive(result, nodeId, 'initial', spec.appear.initial, spec.appear.responsive);
    if (spec.appear.hiddenOn?.length) result = gateMotionPropHidden(result, nodeId, 'initial', spec.appear.hiddenOn, 'false');
    // The resting (whileInView) destination must cover EVERY key any From state
    // touches — base OR a responsive override — else a base-less (scoped-only) appear
    // would rest to `{}` and never animate the override's props back.
    const allFromKeys = { ...spec.appear.initial };
    for (const ov of spec.appear.responsive ?? []) Object.assign(allFromKeys, ov.props);
    result = updateMotionPropInCode(result, nodeId, 'whileInView', restingOf(allFromKeys));
    result = updateMotionPropInCode(result, nodeId, 'viewport', { once: String(spec.appear.once) });
    if (spec.appear.transition) result = updateMotionPropInCode(result, nodeId, 'transition', spec.appear.transition);
  }
  if (spec.animation) {
    result = updateScrollDirectionAnimInCode(result, { nodeId, toProps: spec.animation.toProps,
      direction: spec.animation.direction, replay: spec.animation.replay, transition: spec.animation.transition,
      scope: spec.animation.scope, responsive: spec.animation.responsive });
  }
  if (spec.transform) {
    const tf = spec.transform;
    // Override-only props (e.g. a Tablet-only rotate) must still be emitted as a base
    // (identity) range so there's a `const …Rotate = useTransform(…)` to gate.
    const from = { ...tf.from }, to = { ...tf.to };
    for (const ov of tf.responsive ?? []) {
      for (const p of new Set([...Object.keys(ov.from ?? {}), ...Object.keys(ov.to ?? {})])) {
        if (!(p in from)) from[p] = restingFor(p);
        if (!(p in to)) to[p] = restingFor(p);
      }
    }
    result = updateScrollAnimInCode(result, { nodeId, trigger: tf.trigger as ScrollTrigger,
      stops: [{ progress: 0, props: from }, { progress: 1, props: to }],
      transition: tf.transition } as ScrollAnimConfig);
    // Gate each prop's output range per viewport (reuses buildScopedScalarExpr — the
    // SAME machinery instance-fx + Speed use). Responsive = per-tile VALUES; scope =
    // PRESENCE (off-scope the range collapses to a no-scrub identity).
    if (tf.responsive?.length || tf.scope?.length) result = gateScrollTransformResponsive(result, nodeId, from, to, tf.responsive ?? [], tf.scope);
  }
  if (typeof spec.speed === 'number') result = updateScrollSpeedInCode(result, { nodeId, speed: spec.speed, responsive: spec.speedResponsive ?? [] });
  if (spec.loop) result = setLoopInCode(result, nodeId, spec.loop);
  result = composeAllScrollAppearConflicts(result);
  // Responsive transform can't be reconstructed from the gated code by the separate-
  // form parser, so persist the FULL spec as the authoritative `data-scroll-fx` attr
  // (the same carrier combined nodes use; overwrites any partial one compose emitted).
  // getScrollFx reads it back verbatim.
  if (spec.transform?.responsive?.length || spec.transform?.scope?.length || spec.animation?.responsive?.length || spec.loop?.scope?.length
      || spec.appear?.hiddenOn?.length || spec.hover?.hiddenOn?.length || spec.tap?.hiddenOn?.length) {
    result = injectScrollFxAttr(result, nodeId, spec);
  }
  return result;
}

/** DORMANTIZE for the canvas: a NORMAL node with `data-scroll-fx` keeps its effect machinery as
 *  PAGE-LEVEL hooks (useScroll/useTransform/useMotionValue/useSpring/useInView/useMotionValueEvent
 *  + useEffect) and binds them in style (`scale: <cn>ScaleTapC`, …) + handlers + `ref={<cn>Ref}`.
 *  Moving it into module-scope `canvasNodes` orphans those hooks → "undefined identifier" crash.
 *  Strip the machinery (robustClearScrollFx) but KEEP `data-scroll-fx` so the effect round-trips
 *  (rehydrate regenerates it on re-entry). The normal-node analogue of dormantizeInstanceFx. No-op
 *  without a spec. */
export function dormantizeScrollFx(code: string, nodeId: string): string {
  const spec = getScrollFx(code, nodeId);
  if (!spec || !Object.keys(spec).length) return code;
  const result = robustClearScrollFx(code, nodeId);   // drops hooks + style bindings + ref + effect attrs
  return injectScrollFxAttr(result, nodeId, spec);     // re-attach the spec (rehydrate reads it back)
}

/** REHYDRATE: regenerate the scroll-fx hooks + bindings from the preserved `data-scroll-fx` spec
 *  (the inverse of dormantize) when a node re-enters a viewport. Idempotent. No-op without a spec. */
export function rehydrateScrollFx(code: string, nodeId: string): string {
  const spec = getScrollFx(code, nodeId);
  return spec && Object.keys(spec).length ? setScrollFxInCode(code, nodeId, spec) : code;
}

/** CANVAS-NODE write path: module-scope `canvasNodes` can't hold hooks, so a
 *  scroll effect added/edited/removed on a node ALREADY there is stored
 *  DORMANT — `patch` merged into the `data-scroll-fx` spec, hooks/bindings
 *  stripped. The hook-emitting writers used to run unchanged and bound
 *  function-scope motion values into module-scope style ("References
 *  undefined identifiers …Opacity/…Scale" adding a Scroll Transform on a
 *  canvas-pasted figma import, 2026-08-07). Drag-into-page rehydrates via
 *  rehydrateScrollFx; the AnimationTool already renders spec-driven entries.
 *  An `undefined` value in `patch` DELETES that effect key (the remove form). */
export function writeCanvasNodeScrollFx(code: string, nodeId: string, patch: Partial<ScrollFxSpec>): string {
  const spec: ScrollFxSpec = { ...(getScrollFx(code, nodeId) ?? {}) };
  for (const k of Object.keys(patch) as (keyof ScrollFxSpec)[]) {
    if (patch[k] === undefined) delete spec[k];
    else (spec as any)[k] = patch[k];
  }
  const cleared = robustClearScrollFx(code, nodeId);
  trace.action('generator:canvas-node-scroll-fx', { nodeId, keys: Object.keys(spec) });
  return Object.keys(spec).length ? injectScrollFxAttr(cleared, nodeId, spec) : cleared;
}

/** Resting/neutral value for a prop (matches updateScrollAnimInCode's default). */
const restingFor = (p: string): string => (p === 'opacity' || p === 'scale') ? '1' : '0';

/** Gate each emitted `const <cn><Prop> = useTransform(src, [input], [from, to])` output
 *  range per viewport: `(<gate> ? [ovFrom, ovTo] : [from, to])`. Reuses the shared
 *  buildScopedScalarExpr (arrays qualify as scalar "values"). */
function gateScrollTransformResponsive(
  code: string, nodeId: string,
  from: Record<string, string>, to: Record<string, string>,
  responsive: Array<{ scope: SerScope; from?: Record<string, string>; to?: Record<string, string> }>,
  scope?: SerScope[],
): string {
  const cn = nodeIdToVarName(nodeId);
  let result = code;
  for (const prop of new Set([...Object.keys(from), ...Object.keys(to)])) {
    if (prop.startsWith('Webkit') || prop.startsWith('webkit')) continue;
    const bFrom = from[prop], bTo = to[prop];
    if (bFrom === '' || bTo === '' || bFrom == null || bTo == null) continue;
    const numeric = !isNaN(Number(bFrom)) && !isNaN(Number(bTo));
    if (!numeric && (/\(/.test(bFrom) || /\(/.test(bTo))) continue;   // decomposed (complex CSS) — skip
    const fmt = (a: string, b: string) => numeric ? `[${a}, ${b}]` : `["${a}", "${b}"]`;
    const baseStr = fmt(bFrom, bTo);
    // Per-viewport VALUE overrides (different From/To per tile).
    const overrides = responsive
      .map((r) => {
        const oF = r.from?.[prop], oT = r.to?.[prop];
        if (oF == null && oT == null) return null;
        return { scope: r.scope, value: fmt(oF ?? bFrom, oT ?? bTo) };
      })
      .filter((o): o is { scope: SerScope; value: string } => o !== null);
    // The real (responsive-gated) output range. `(ov ? [..] : [from,to])` or bare base.
    let valueExpr = baseStr;
    if (overrides.length) { const built = buildScopedScalarExpr(result, baseStr, overrides); result = built.code; valueExpr = built.expr; }
    // PRESENCE: present-only on `scope` → off-scope collapse to a no-scrub identity range
    // (the prop's resting value at BOTH ends), so the transform doesn't scrub elsewhere.
    let outExpr = valueExpr;
    if (scope?.length && numeric) {
      const rest = (prop === 'opacity' || prop.startsWith('scale')) ? '1' : '0';
      const built = buildScopedScalarExpr(result, `[${rest}, ${rest}]`, scope.map((s) => ({ scope: s, value: valueExpr })));
      result = built.code; outExpr = built.expr;
    }
    if (outExpr === baseStr) continue;   // nothing gated for this prop
    const vn = escapeRegExp(`${cn}${prop.charAt(0).toUpperCase()}${prop.slice(1)}`);
    const esc = escapeRegExp(baseStr);
    const re = new RegExp(`(const ${vn} = useTransform\\([^,]+,\\s*\\[[^\\]]*\\],\\s*)${esc}(\\s*\\))`);
    result = result.replace(re, `$1${outExpr}$2`);
  }
  return result;
}

/** Add a `prop: motionVar` binding to a node's `style={{ … }}` (motion.<tag>). */
function injectStyleMotionBinding(code: string, nodeId: string, prop: string, motionVar: string): string {
  code = ensureMotionTag(code, nodeId);
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return code;
  const tagStart = code.lastIndexOf('<', idIdx);
  const styleIdx = code.indexOf('style={{', tagStart);
  if (styleIdx === -1) return code;
  const open = styleIdx + 'style={{'.length;
  const close = findStyleObjectEnd(code, open);
  if (close === -1) return code;
  let inner = code.slice(open, close);
  // Replace any existing binding for this prop, else append. Match `prop` as a
  // WHOLE key — anchored to start or a comma — so prop 'y' does NOT clip the
  // `y:` inside a longer key like `opacity:` (which corrupted it to `opacit`).
  const propRe = new RegExp(`(?:^|,)\\s*${prop}\\s*:\\s*[^,}]+`);
  inner = inner.replace(propRe, '');
  inner = inner.trim().replace(/^,\s*/, '').replace(/,\s*$/, '');
  const sep = inner.length ? ', ' : '';
  return code.slice(0, open) + inner + `${sep}${prop}: ${motionVar}` + code.slice(close);
}

export function removeScrollSpeedFromCode(code: string, nodeId: string): string {
  const cleanName = nodeIdToVarName(nodeId);
  const cn = escapeRegExp(cleanName);
  let r = code;
  r = r.replace(new RegExp(`\\s*const \\{\\s*scrollY:\\s*${cn}SpeedScroll\\s*\\} = useScroll\\([^;]*\\);`, 'g'), '');
  r = r.replace(new RegExp(`\\s*const ${cn}SpeedY = useTransform\\([\\s\\S]*?\\);`, 'g'), '');
  r = r.replace(new RegExp(`,?\\s*y:\\s*${cn}SpeedY`, 'g'), '');
  return r;
}

/** Read a node's Speed as base + per-scope overrides (inverse of the gated emit). */
export function getSpeedResponsive(
  code: string, nodeId: string,
): { base: number; responsive: Array<{ scope: SerScope; speed: number }> } | null {
  const cleanName = nodeIdToVarName(nodeId);
  const cn = escapeRegExp(cleanName);
  const m = code.match(new RegExp(`const ${cn}SpeedY = useTransform\\([^,]+,\\s*\\(v\\)\\s*=>\\s*v \\* \\(1 - ([\\s\\S]+?) / 100\\)\\)`));
  if (!m) return null;
  const { base, responsive } = parseScopedScalarExpr(code, m[1]);
  return { base: parseFloat(base) || 100, responsive: responsive.map(r => ({ scope: r.scope, speed: parseFloat(r.value) })) };
}

export function updateScrollSpeedInCode(code: string, config: ScrollSpeedConfig): string {
  trace.fn('generator.updateScrollSpeed', { nodeId: config.nodeId, speed: config.speed, scope: config.scope });
  const { nodeId, speed, scope, responsive } = config;
  const cleanName = nodeIdToVarName(nodeId);
  const scrollVar = `${cleanName}SpeedScroll`;
  const yVar = `${cleanName}SpeedY`;

  // Resolve base + per-scope overrides. `responsive` (spec regen) is authoritative;
  // otherwise a scoped edit merges into the EXISTING branches (keeps base + siblings),
  // a base edit replaces the base.
  let base: number;
  let overrides: Array<{ scope: SerScope; speed: number }>;
  if (responsive !== undefined) {
    base = speed; overrides = responsive;
  } else {
    const existing = getSpeedResponsive(code, nodeId);
    base = scope ? (existing?.base ?? 100) : speed;
    overrides = (existing?.responsive ?? []).filter(o => !scope || scopeKey(o.scope) !== scopeKey(scope));
    if (scope) overrides.push({ scope, speed });
  }

  let result = removeScrollSpeedFromCode(code, nodeId);
  const scoped = buildScopedScalarExpr(result, String(base), overrides.map(o => ({ scope: o.scope, value: String(o.speed) })));
  result = scoped.code;
  const lines = [
    `  const { scrollY: ${scrollVar} } = useScroll();`,
    `  const ${yVar} = useTransform(${scrollVar}, (v) => v * (1 - ${scoped.expr} / 100));`,
  ];
  const withHooks = insertBeforeRenderReturn(result, lines.join('\n'));
  if (withHooks === null) return code;
  result = withHooks;
  return injectStyleMotionBinding(result, nodeId, 'y', yVar);
}

/** Reset Override on Speed: drop one scope's branch (keep base + siblings), or remove
 *  Speed entirely if that was the only thing and the base is identity (100). */
export function removeScrollSpeedScopeBranch(code: string, nodeId: string, scope: SerScope): string {
  const existing = getSpeedResponsive(code, nodeId);
  if (!existing) return code;
  const responsive = existing.responsive.filter(o => scopeKey(o.scope) !== scopeKey(scope));
  if (responsive.length === existing.responsive.length) return code; // nothing matched
  if (!responsive.length && existing.base === 100) return removeScrollSpeedFromCode(code, nodeId);
  return updateScrollSpeedInCode(code, { nodeId, speed: existing.base, responsive });
}

export function removeScrollAnimFromCode(code: string, nodeId: string): string {
  trace.fn('generator.removeScrollAnimFromCode', { nodeId });

  let result = code;
  const parsed = parseScrollHooks(code);
  const nodeScroll = getScrollDataForNode(parsed, nodeId);

  if (nodeScroll.bindings.length > 0) {
    // Collect actual transform var names bound to this node
    const oldTransformVars = new Set(nodeScroll.bindings.map(b => b.transformVar));
    const oldSourceVars = new Set(nodeScroll.transforms.map(t => t.sourceVar));

    // Check if other nodes share any of these sources
    const otherBindings = parsed.bindings.filter(b => b.nodeId !== nodeId);
    const otherTransformVars = new Set(otherBindings.map(b => b.transformVar));
    const otherSourceVars = new Set<string>();
    for (const t of parsed.transforms) {
      if (otherTransformVars.has(t.varName)) otherSourceVars.add(t.sourceVar);
    }

    // Remove useTransform declarations by exact var name
    for (const varName of oldTransformVars) {
      const regex = new RegExp(`\\s*const ${varName} = (?:useSpring\\(\\s*)?useTransform\\([^;]*;`, 'g');
      result = result.replace(regex, '');
    }

    // Remove source + ref only if no other node uses them
    for (const srcVar of oldSourceVars) {
      if (!otherSourceVars.has(srcVar)) {
        // Remove spring-smoothed variants of this source
        for (const t of parsed.transforms) {
          if (t.sourceVar === srcVar && t.isSpring && !otherTransformVars.has(t.varName)) {
            const springRegex = new RegExp(`\\s*const ${t.varName} = useSpring\\([^;]*;`);
            result = result.replace(springRegex, '');
          }
        }
        // Remove useScroll declaration
        const scrollRegex = new RegExp(`\\s*const \\{[^}]*:\\s*${srcVar}\\s*\\} = useScroll\\([\\s\\S]*?\\);`);
        result = result.replace(scrollRegex, '');
        // Remove the ref
        const src = parsed.sources.find(s => s.progressVar === srcVar);
        if (src?.refVar) {
          const refUsedElsewhere = parsed.sources.some(s => s.progressVar !== srcVar && s.refVar === src.refVar);
          if (!refUsedElsewhere) {
            const refRegex = new RegExp(`\\s*const ${src.refVar} = useRef\\(null\\);`);
            result = result.replace(refRegex, '');
            result = result.replace(new RegExp(`ref=\\{${src.refVar}\\}\\s*`, 'g'), '');
          }
        }
      }
    }

    // Remove style bindings by actual var names
    const idPattern = `data-id="${nodeId}"`;
    const idIdx = findJSXDataIdIndex(result, nodeId);
    if (idIdx !== -1) {
      const tagStart = result.lastIndexOf('<', idIdx);
      const tagEnd = findTagClose(result, idIdx);
      if (tagStart !== -1 && tagEnd !== -1) {
        const styleStartIdx = result.indexOf('style={{', tagStart);
        if (styleStartIdx !== -1 && styleStartIdx < tagEnd) {
          const sStart = styleStartIdx + 'style={{'.length;
          const sClose = findStyleObjectEnd(result, sStart);
          if (sClose !== -1) {
            let styleContent = result.slice(sStart, sClose);
            for (const b of nodeScroll.bindings) {
              const bindRegex = new RegExp(`,?\\s*${b.property}:\\s*${b.transformVar}\\b`);
              styleContent = styleContent.replace(bindRegex, '');
            }
            styleContent = styleContent.replace(/^\s*,/, '');
            result = result.slice(0, sStart) + styleContent + result.slice(sClose);
          }
        }
      }
    }

    trace.action('generator.removeScrollAnim:removed', {
      nodeId, removedTransforms: [...oldTransformVars], removedSources: [...oldSourceVars],
    });
  } else {
    // Fallback: cleanName-based removal for our own generated hooks
    const cleanName = nodeIdToVarName(nodeId);
    const refName = `${cleanName}Ref`;
    const progressName = `${cleanName}Progress`;

    const transformRegex = new RegExp(`  const \\w+ = (?:useSpring\\(\\s*)?useTransform\\((?:${progressName}|${cleanName}Smooth)[^;]*;\\n`, 'g');
    result = result.replace(transformRegex, '');
    const springRegex = new RegExp(`  const ${cleanName}Smooth = useSpring\\([^;]*;\\n`);
    result = result.replace(springRegex, '');
    const scrollRegex = new RegExp(`  const \\{ scrollYProgress: ${progressName} \\} = useScroll\\([\\s\\S]*?\\);\\n`);
    result = result.replace(scrollRegex, '');
    const refRegex = new RegExp(`  const ${refName} = useRef\\(null\\);\\n`);
    result = result.replace(refRegex, '');
    result = result.replace(new RegExp(`ref=\\{${refName}\\}\\s*`, 'g'), '');

    // Remove style bindings
    const idPattern = `data-id="${nodeId}"`;
    const idIdx = findJSXDataIdIndex(result, nodeId);
    if (idIdx !== -1) {
      const tagStart = result.lastIndexOf('<', idIdx);
      const tagEnd = findTagClose(result, idIdx);
      if (tagStart !== -1 && tagEnd !== -1) {
        let tag = result.slice(tagStart, tagEnd + 1);
        // Exclude `<cleanName>Speed*` — Scroll Speed (parallax) is a SEPARATE
        // stackable effect; removing the scrubbed scroll must not touch it.
        const bindRegex = new RegExp(`,?\\s*\\w+:\\s*${cleanName}(?!Speed)[A-Z]\\w*`, 'g');
        tag = tag.replace(bindRegex, '');
        result = result.slice(0, tagStart) + tag + result.slice(tagEnd + 1);
      }
    }
  }

  // Multi-section artifacts cleanup. These don't live in `parsed.bindings`
  // and aren't covered by the cleanName fallback above, so they survive
  // the normal scroll-strip when the user deletes the animated node.
  // Strip section refs, positions state, and the mount-effect that
  // resolves them — all keyed off the cleanName for THIS nodeId.
  const cleanNameMS = nodeIdToVarName(nodeId);
  // `<cleanName>Sec\d+Ref` declarations + their JSX attribute refs.
  result = result.replace(new RegExp(`\\s*const ${cleanNameMS}Sec\\d+Ref\\s*=\\s*useRef\\(null\\);`, 'g'), '');
  result = result.replace(new RegExp(`\\s*ref=\\{${cleanNameMS}Sec\\d+Ref\\}`, 'g'), '');
  // `[<cleanName>SecPositions, set<…>SecPositions] = useState(...)`
  result = result.replace(new RegExp(`\\s*const \\[${cleanNameMS}SecPositions,\\s*set\\w*SecPositions\\][^;]*;`, 'g'), '');
  // The mount-effect (anything referencing our setter). Use a brace-
  // balanced match — useEffect body contains nested braces.
  result = result.replace(
    new RegExp(`\\s*useEffect\\(\\s*\\(\\)\\s*=>\\s*\\{[\\s\\S]*?set\\w*SecPositions[\\s\\S]*?\\},\\s*\\[\\]\\);`, 'g'),
    (match) => match.includes(cleanNameMS) ? '' : match,
  );

  // Clean extra blank lines
  result = result.replace(/\n{3,}/g, '\n\n');

  return result;
}

export { injectScrollFxAttr, injectAttrsBeforeClose, injectStyleMotionBinding, emitMotionPropResponsive, gateMotionPropHidden, restingOf, restingFor };
export type { FxScopeOverride };
