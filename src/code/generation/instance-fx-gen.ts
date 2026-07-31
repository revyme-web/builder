// instance-fx-gen.ts — page-level effects for COMPONENT INSTANCES (Hover / Press /
// Appear / Loop). Regular `motion.*` nodes use the element-based compose in
// generator-motion.ts; component instances can't carry `whileHover`/`animate` (the
// component only forwards `style` + `ref`), so every effect lives at the PAGE level
// as a motion value bound to the instance's `style`, exactly like Scroll Variant.
//
// All effects for a node are stored as ONE `data-instance-fx='<json>'` spec on the
// instance; the page block is REGENERATED from the spec on every write (set = strip
// old + inject fresh), so the spec is the single source of truth — no fragile
// incremental compose/decompose.
//
// Compose: per CSS prop, every effect's motion value is combined into one composed
// value bound to `style` — opacity/scale MULTIPLY, x/y/rotate/skew ADD. Any motion
// value already bound to that prop by the scroll system (Speed/Transform) is folded
// into the same composition, so the whole suite blends on ONE element.
import { trace } from '@/shared/debug-trace';
import { nodeIdToVarName } from '@/shared/id-utils';
import { parseJSX } from '@/code/parsing/ast-utils';
import { findJSXDataIdIndex, insertBeforeRenderReturn, setTagAttr, getJsonAttr } from './generator-utils';
import { buildScopedScalarExpr, type SerScope } from './scoped-expr';
import { scopeEq, presentOn, isPresenceOverride, addPresenceScope, hidePresenceOn, resetPresenceScope, type PresenceState } from '@/code/animations/presence';

/** A per-viewport (or per-variant) override of an effect's VALUES. `scope` is the
 *  banded media query (page viewport) — same form the normal-node responsive path
 *  uses — so one `useMediaQuery` gate can be shared across effects. Only the value
 *  keys an effect owns are carried (e.g. transform → from/to); structural fields
 *  (trigger, sectionId) are never scoped. */
type FxTransformOverride = { scope: SerScope; from?: FxProps; to?: FxProps };

/** A per-viewport/variant override of a single-target effect's VALUES (hover/tap → `to`).
 *  Same shape + gating as FxTransformOverride; just one props bag. */
export type FxValueOverride = { scope: SerScope; to?: FxProps };

interface FxTransition {
  type?: 'spring' | 'tween';
  stiffness?: number; damping?: number; mass?: number;
  duration?: number; ease?: string; delay?: number;
  repeat?: number | 'Infinity'; repeatType?: 'loop' | 'reverse' | 'mirror';
}
/** A map of animatable CSS props → target number (e.g. { scale: 1.05, opacity: 0.8 }). */
export type FxProps = Record<string, number>;

export interface InstanceFxSpec {
  /** `responsive` = per-viewport/variant VALUE overrides of `to` (base lives in `to`).
   *  Each prop's gated enter target is `(<gate> ? <override> : <base>)` — SAME machinery
   *  as Transform's `responsive`, so editing hover on a replica changes ONLY that tile. */
  hover?: { to: FxProps; transition?: FxTransition; responsive?: FxValueOverride[] };
  tap?: { to: FxProps; transition?: FxTransition; responsive?: FxValueOverride[] };
  /** Appear animates FROM these values up to the resting base, triggered by:
   *  onAppear (mount), onScroll (scroll direction), or layerInView (element reaches a
   *  viewport line). `replay` reverts to `from` when the trigger un-fires. */
  appear?: {
    from: FxProps;
    trigger?: 'onAppear' | 'onScroll' | 'layerInView';
    start?: 'top' | 'center' | 'bottom';   // layerInView line
    direction?: 'up' | 'down';             // onScroll
    replay?: boolean;
    transition?: FxTransition;
    /** Per-viewport overrides of the FROM values (base lives in `from`). */
    responsive?: Array<{ scope: SerScope; from?: FxProps }>;
  };
  /** Loop repeats each prop through its keyframes forever. */
  loop?: { keyframes: Record<string, number[]>; transition?: FxTransition };
  /** Scroll Speed parallax: 100 = none, <100 slower, >100 faster. Drives `y`. */
  speed?: number;
  /** Per-viewport overrides of the Speed value (base lives in `speed`). */
  speedResponsive?: Array<{ scope: SerScope; speed: number }>;
  /** Scroll Transform: scroll-progress-driven From→To per prop. Trigger picks the
   *  progress source — onScroll (element through viewport), layerInView (same, kept for
   *  parity), or sectionInView (a page anchor's scroll through the viewport). */
  transform?: {
    from: FxProps;
    to: FxProps;
    trigger?: 'onScroll' | 'layerInView' | 'sectionInView';
    sectionId?: string;                        // sectionInView anchor id
    viewport?: 'top' | 'middle' | 'bottom';    // sectionInView offset alignment
    transition?: FxTransition;
    /** Per-viewport overrides of from/to (the base lives in from/to above). Each
     *  prop's gated runtime value is `(<gate> ? <override> : <base>)`. */
    responsive?: FxTransformOverride[];
  };
  /** Per-effect per-viewport PRESENCE (the reference 3-state). `presence[key].scope` = the
   *  effect runs ONLY on those viewports (added on a replica → absent on primary);
   *  `presence[key].hiddenOn` = a base effect turned OFF on those viewports (deleted on
   *  a replica). Absent ⇒ runs everywhere. Codegen gates the effect's magnitude to the
   *  NEUTRAL value off-scope (scale/opacity→1, x/y/rotate→0, speed→100), so it's a
   *  visual no-op there. */
  presence?: Partial<Record<FxKey, { scope?: SerScope[]; hiddenOn?: SerScope[] }>>;
}

export type FxKey = 'hover' | 'tap' | 'appear' | 'loop' | 'speed' | 'transform';

/** Whether the spec attaches a ref to the INSTANCE — pointer gestures (hover/press),
 *  a layerInView Appear, or a non-section Scroll Transform (its `useScroll` targets the
 *  element's box). When true the COMPONENT must forward that ref
 *  (`ensureComponentAcceptsRef`); otherwise `ref.current` is null and motion's
 *  `useScroll`/`hover`/`press` throw "Target ref is defined but not hydrated". This is
 *  the SINGLE source of truth — both setInstanceFxInCode (which attaches the ref) and
 *  the tool (which patches the component file) read it, so they can't drift. */
export function instanceFxNeedsRef(spec: InstanceFxSpec | null | undefined): boolean {
  if (!spec) return false;
  const transformNeedsRef = !!spec.transform && (spec.transform.trigger ?? 'onScroll') !== 'sectionInView';
  return !!(spec.hover || spec.tap || transformNeedsRef || spec.appear?.trigger === 'layerInView');
}

// useScroll offset per Section-in-View viewport alignment.
const SECTION_OFFSET: Record<string, string> = {
  top: "['start start', 'end start']",
  middle: "['start center', 'end center']",
  bottom: "['start end', 'end end']",
};

// Compose op per prop. Multiplicative props rest at 1, additive at 0.
const MUL_PROPS = new Set(['opacity', 'scale', 'scaleX', 'scaleY']);
// layerInView trigger line as a fraction of viewport height (top=viewport top, etc.).
// Mirrors scroll-variant-gen's LINE_FRACTION.
const LINE_FRACTION: Record<string, number> = { top: 0, center: 0.5, middle: 0.5, bottom: 1 };
const baseOf = (prop: string) => (MUL_PROPS.has(prop) ? 1 : 0);
const cleanNameOf = nodeIdToVarName;
const Cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const numProps = (m: FxProps) => Object.keys(m).filter((p) => typeof m[p] === 'number');

/** A node's opening tag (without trailing `>`), brace/string-aware. */
function getOpeningTag(code: string, nodeId: string): { tag: string; tagStart: number; gt: number } | null {
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return null;
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
  if (gt === -1) return null;
  return { tag: code.slice(tagStart, gt), tagStart, gt };
}

/** Render an FxTransition as a JSX object-literal string. Defaults per effect kind. */
function fmtTransition(t: FxTransition | undefined, kind: 'gesture' | 'appear' | 'loop'): string {
  const d: FxTransition = t ?? (kind === 'loop'
    ? { type: 'tween', duration: 4, ease: 'linear', repeat: 'Infinity' }
    : { type: 'spring', stiffness: 300, damping: 30 });
  const parts: string[] = [];
  if (d.type) parts.push(`type: '${d.type}'`);
  if (d.stiffness != null) parts.push(`stiffness: ${d.stiffness}`);
  if (d.damping != null) parts.push(`damping: ${d.damping}`);
  if (d.mass != null) parts.push(`mass: ${d.mass}`);
  if (d.duration != null) parts.push(`duration: ${d.duration}`);
  if (d.ease != null) parts.push(`ease: '${d.ease}'`);
  if (d.delay != null) parts.push(`delay: ${d.delay}`);
  if (d.repeat != null) parts.push(`repeat: ${d.repeat === 'Infinity' ? 'Infinity' : d.repeat}`);
  if (d.repeatType != null) parts.push(`repeatType: '${d.repeatType}'`);
  return `{ ${parts.join(', ')} }`;
}

/** Ensure ONE shared instance ref (`<cn>Ref`) is declared + on the instance tag, reusing
 *  any existing `ref={…}` (e.g. a Scroll Variant layerInView ref) so the two systems
 *  never collide on the single ref slot. Returns the ref var name. */
function ensureInstanceRef(code: string, nodeId: string, cn: string): { code: string; refVar: string } {
  const got = getOpeningTag(code, nodeId);
  if (!got) return { code, refVar: `${cn}Ref` };
  const existing = got.tag.match(/\bref=\{(\w+)\}/);
  if (existing) return { code, refVar: existing[1] };
  const refVar = `${cn}Ref`;
  let result = code;
  // Declare the ref just before the component's return, if missing.
  if (!new RegExp(`const ${refVar}\\s*=\\s*useRef\\(`).test(result)) {
    result = insertBeforeRenderReturn(result, `  const ${refVar} = useRef(null);`) ?? result;
  }
  // Add ref={refVar} to the instance tag.
  const g2 = getOpeningTag(result, nodeId);
  if (g2) {
    const tag = g2.tag.replace(/^(<[a-zA-Z][\w.]*)/, `$1 ref={${refVar}}`);
    result = result.slice(0, g2.tagStart) + tag + result.slice(g2.gt);
  }
  return { code: result, refVar };
}

/** Read the instance `style={{ … }}` and return prop → motion-value identifier for any
 *  prop already bound to a bare identifier (Scroll Speed/Transform), EXCLUDING our own
 *  `<cn>Fx…` vars (which we regenerate). Lets us fold scroll values into the compose. */
function readExternalStyleBindings(code: string, nodeId: string, cn: string): Record<string, string> {
  const got = getOpeningTag(code, nodeId);
  if (!got) return {};
  const m = got.tag.match(/style=\{\{([\s\S]*?)\}\}/);
  if (!m) return {};
  const out: Record<string, string> = {};
  // Only simple `prop: ident` pairs (motion-value bindings). Skip object/spread/string.
  for (const part of m[1].split(',')) {
    const pm = part.match(/^\s*(\w+)\s*:\s*([A-Za-z_$][\w$]*)\s*$/);
    if (!pm) continue;
    const [, prop, ident] = pm;
    if (ident.startsWith(`${cn}Fx`)) continue;          // our own composed/effect var
    if (ident === 'style') continue;
    out[prop] = ident;
  }
  return out;
}

/** Set/replace/remove (`spec=null`) a component instance's effect suite. Regenerates the
 *  whole page-level block from the spec + composes every prop into `style`. */
export function setInstanceFxInCode(code: string, nodeId: string, spec: InstanceFxSpec | null): string {
  trace.fn('instanceFx.set', { nodeId, effects: spec ? Object.keys(spec) : 'remove' });
  const cn = cleanNameOf(nodeId);
  let result = stripInstanceFx(code, nodeId, cn);
  const hasAny = spec && (spec.hover || spec.tap || spec.appear || spec.loop
    || (spec.speed != null && spec.speed !== 100) || spec.transform);
  if (!hasAny) return result;

  // Need the shared ref for pointer gestures (hover/press) AND for Scroll Transform,
  // whose progress is tied to the ELEMENT's box (not the whole page).
  let refVar = `${cn}Ref`;
  if (instanceFxNeedsRef(spec)) {
    const r = ensureInstanceRef(result, nodeId, cn);
    result = r.code; refVar = r.refVar;
  }

  // 1. Per-effect motion-value declarations + their useEffect wiring.
  const decls: string[] = [];
  const effects: string[] = [];
  // propMVs[prop] = list of motion-value identifiers contributing to that prop.
  const propMVs: Record<string, string[]> = {};
  const addMV = (prop: string, mv: string) => { (propMVs[prop] ??= []).push(mv); };

  // PRESENCE gate: returns the magnitude expr gated to NEUTRAL off-scope (so the effect
  // is a visual no-op on viewports where it's not present), ensuring each gate const in
  // `result`. `baseVal`/`neutralVal` are pre-formatted strings (number or `[a, b]`).
  //   scope    → present only there: `(gate ? baseVal : neutralVal)`
  //   hiddenOn → off there:          `(gate ? neutralVal : baseVal)`
  const pres = spec!.presence ?? {};
  const gateP = (key: FxKey, baseVal: string, neutralVal: string): string => {
    const p = pres[key];
    // Nothing to gate when present-everywhere OR the value already equals neutral
    // (e.g. a loop whose first keyframe is the resting value) → avoid `(gate ? x : x)`.
    if (baseVal === neutralVal) return baseVal;
    if (p?.scope?.length) {
      const b = buildScopedScalarExpr(result, neutralVal, p.scope.map((s) => ({ scope: s, value: baseVal })));
      result = b.code; return b.expr;
    }
    if (p?.hiddenOn?.length) {
      const b = buildScopedScalarExpr(result, baseVal, p.hiddenOn.map((s) => ({ scope: s, value: neutralVal })));
      result = b.code; return b.expr;
    }
    return baseVal;
  };
  // The `__mqN` gate vars referenced in a set of generated lines, as a useEffect dep
  // list — so an effect gated for presence RE-RUNS when the viewport band changes.
  const gateDeps = (lines: string[]): string =>
    [...new Set(lines.join('\n').match(/__mq\d+/g) ?? [])].join(', ');

  // VALUE-responsive: gate a single prop's scalar to `(gate ? override : base)` per
  // viewport/variant, ensuring each useMediaQuery const. An override equal to the base
  // is skipped (off-scope already falls back to base) so the output stays bare. This is
  // the SAME machinery Transform's endpoints use — shared so hover/tap/appear/speed all
  // become per-tile responsive exactly like normal-node `data-scroll-fx`. Returns a
  // pre-formatted string fed to gateP (presence wraps value-responsive).
  const gateScalar = (base: number, overrides: Array<{ scope: SerScope; v: number | undefined }>): string => {
    const ovs = overrides
      .filter((o): o is { scope: SerScope; v: number } => typeof o.v === 'number' && o.v !== base)
      .map((o) => ({ scope: o.scope, value: String(o.v) }));
    if (!ovs.length) return String(base);
    const built = buildScopedScalarExpr(result, String(base), ovs);
    result = built.code;
    return built.expr;
  };

  const gesture = (kind: 'Hov' | 'Tap', key: FxKey, to: FxProps, transition: FxTransition | undefined, fn: 'hover' | 'press', responsive?: FxValueOverride[]) => {
    const resp = responsive ?? [];
    // The prop set spans the base AND every responsive override — so a prop that exists
    // ONLY on a replica (e.g. a Tablet-only `rotate`) still gets a motion value, gated to
    // its NEUTRAL base off-scope. Without this union an override-only prop was dropped
    // entirely (Tablet rotate never emitted → "stays as desktop").
    const props = Array.from(new Set([...numProps(to), ...resp.flatMap((r) => numProps(r.to ?? {}))]));
    if (!props.length) return;
    const trans = fmtTransition(transition, 'gesture');
    const starts: string[] = [], ends: string[] = [];
    for (const p of props) {
      const mv = `${cn}Fx${kind}${Cap(p)}`;
      decls.push(`  const ${mv} = useMotionValue(${baseOf(p)});`);
      addMV(p, mv);
      // VALUE-responsive: per-tile enter target (Tablet hover scale 1.5, Desktop 1.05).
      // The base for an override-only prop is its neutral value (so off-scope = no effect).
      // PRESENCE wraps it: off its scope the target is the resting/neutral value → no hover.
      const valExpr = gateScalar(to[p] ?? baseOf(p), resp.map((r) => ({ scope: r.scope, v: r.to?.[p] })));
      starts.push(`        animate(${mv}, ${gateP(key, valExpr, String(baseOf(p)))}, ${trans});`);
      ends.push(`          animate(${mv}, ${baseOf(p)}, ${trans});`);
    }
    effects.push(
      `  useEffect(() => {`,
      `    const el = ${refVar}.current;`,
      `    if (!el) return;`,
      `    return ${fn}(el, () => {`,
      ...starts,
      `      return () => {`,
      ...ends,
      `      };`,
      `    });`,
      // Depend on the presence gate(s): without this the [] effect captures `__mqN`
      // ONCE at mount, so crossing the breakpoint (resize) leaves the OLD target frozen
      // → e.g. a tablet-only hover keeps firing on desktop. Listing the gate re-attaches
      // hover() with the fresh target when the viewport band changes.
      `  }, [${gateDeps(starts)}]);`,
    );
  };

  if (spec!.hover) gesture('Hov', 'hover', spec!.hover.to, spec!.hover.transition, 'hover', spec!.hover.responsive);
  if (spec!.tap) gesture('Tap', 'tap', spec!.tap.to, spec!.tap.transition, 'press', spec!.tap.responsive);

  if (spec!.appear) {
    const ap = spec!.appear;
    // Union base + responsive FROM keys so a replica-only prop still emits (see gesture).
    const apResp = ap.responsive ?? [];
    const props = Array.from(new Set([...numProps(ap.from), ...apResp.flatMap((r) => numProps(r.from ?? {}))]));
    if (props.length) {
      const trans = fmtTransition(ap.transition, 'appear');
      const trigger = ap.trigger ?? 'onAppear';
      const mvOf: Record<string, string> = {};
      // VALUE-responsive FROM per tile, then PRESENCE: off-scope the FROM is the
      // resting/neutral value, so the element starts AT rest and the appear is a no-op.
      const fromGated: Record<string, string> = {};
      for (const p of props) {
        const valExpr = gateScalar(ap.from[p] ?? baseOf(p), apResp.map((r) => ({ scope: r.scope, v: r.from?.[p] })));
        fromGated[p] = gateP('appear', valExpr, String(baseOf(p)));
      }
      for (const p of props) {
        const mv = `${cn}FxApp${Cap(p)}`;
        decls.push(`  const ${mv} = useMotionValue(${fromGated[p]});`);          // start at FROM (gated)
        addMV(p, mv); mvOf[p] = mv;
      }
      const toBase = (ind: string) => props.map((p) => `${ind}animate(${mvOf[p]}, ${baseOf(p)}, ${trans});`);
      const toFrom = (ind: string) => props.map((p) => `${ind}animate(${mvOf[p]}, ${fromGated[p]}, ${trans});`);
      const replay = ap.replay !== false;
      if (trigger === 'onAppear') {
        effects.push(`  useEffect(() => {`, ...toBase('    '), `  }, []);`);     // mount → base
      } else if (trigger === 'layerInView') {
        const frac = LINE_FRACTION[ap.start ?? 'center'];
        const threshold = frac === 0 ? '0' : `window.innerHeight * ${frac}`;
        const scroll = `${cn}FxAppScroll`;
        decls.push(`  const { scrollY: ${scroll} } = useScroll();`);
        effects.push(
          `  useMotionValueEvent(${scroll}, "change", () => {`,
          `    const el = ${refVar}.current;`,
          `    if (el) {`,
          `      const past = el.getBoundingClientRect().top <= ${threshold};`,
          `      if (past) {`, ...toBase('        '), `      }`,
          ...(replay ? [`      else {`, ...toFrom('        '), `      }`] : []),
          `    }`,
          `  });`,
        );
      } else { // onScroll
        const scroll = `${cn}FxAppScroll`;
        decls.push(`  const { scrollY: ${scroll} } = useScroll();`);
        const down = ap.direction === 'up' ? toFrom : toBase;
        const up = ap.direction === 'up' ? toBase : toFrom;
        effects.push(
          `  useMotionValueEvent(${scroll}, "change", (y) => {`,
          `    const prev = ${scroll}.getPrevious() ?? 0;`,
          `    if (y > prev) {`, ...down('      '), `    }`,
          ...(replay ? [`    else if (y < prev) {`, ...up('      '), `    }`] : []),
          `  });`,
        );
      }
    }
  }

  if (spec!.loop) {
    const props = Object.keys(spec!.loop.keyframes).filter((p) => Array.isArray(spec!.loop!.keyframes[p]));
    if (props.length) {
      const trans = fmtTransition(spec!.loop.transition, 'loop');
      const controls: string[] = [], stops: string[] = [];
      props.forEach((p, i) => {
        const mv = `${cn}FxLoop${Cap(p)}`;
        const kf = spec!.loop!.keyframes[p];
        const neutral = String(baseOf(p));
        // Off-scope: a single-value keyframe array (the neutral) → no loop.
        const initGated = gateP('loop', String(kf[0] ?? baseOf(p)), neutral);
        const kfGated = gateP('loop', `[${kf.join(', ')}]`, `[${neutral}]`);
        decls.push(`  const ${mv} = useMotionValue(${initGated});`);
        addMV(p, mv);
        controls.push(`    const c${i} = animate(${mv}, ${kfGated}, ${trans});`);
        stops.push(`c${i}.stop();`);
      });
      effects.push(`  useEffect(() => {`, ...controls, `    return () => { ${stops.join(' ')} };`, `  }, [${gateDeps(controls)}]);`);
    }
  }

  // Scroll effects — page-scroll-driven motion values that join the SAME composition
  // (so Scroll Speed/Transform blend with hover/tap/appear/loop on the instance).
  if (spec!.speed != null && spec!.speed !== 100) {
    const scroll = `${cn}FxSpeedScroll`, y = `${cn}FxSpeedY`;
    decls.push(`  const { scrollY: ${scroll} } = useScroll();`);
    // VALUE-responsive speed per tile, then PRESENCE: off-scope speed = 100 → factor
    // (1 - 100/100) = 0 → no parallax (neutral).
    const speedVal = gateScalar(spec!.speed, (spec!.speedResponsive ?? []).map((r) => ({ scope: r.scope, v: r.speed })));
    const speedGated = gateP('speed', speedVal, '100');
    decls.push(`  const ${y} = useTransform(${scroll}, (v) => v * (1 - ${speedGated} / 100));`);
    addMV('y', y);
  }
  if (spec!.transform) {
    const tf = spec!.transform;
    const trigger = tf.trigger ?? 'onScroll';
    const prog = `${cn}FxTfP`;
    if (trigger === 'sectionInView' && tf.sectionId) {
      // Progress tied to a PAGE ANCHOR scrolling through the viewport. The getElementById
      // useEffect MUST be declared BEFORE useScroll reads the ref (React runs effects in
      // order), so it lives inline in the decls block, not the trailing effects.
      const secRef = `${cn}FxTfSecRef`;
      decls.push(`  const ${secRef} = useRef(null);`);
      decls.push(`  useEffect(() => { ${secRef}.current = document.getElementById('${tf.sectionId}'); }, []);`);
      decls.push(`  const { scrollYProgress: ${prog} } = useScroll({ target: ${secRef}, offset: ${SECTION_OFFSET[tf.viewport ?? 'middle']} });`);
    } else {
      // onScroll / layerInView: the INSTANCE scrolling through the viewport (0 enters
      // bottom → 1 leaves top), so From→To scrubs while it's on screen — NOT whole-page
      // progress (which only hits 1 at the page bottom, long after the element left).
      // Needs the instance ref. This is also what existing (trigger-less) transforms use.
      decls.push(`  const { scrollYProgress: ${prog} } = useScroll({ target: ${refVar}, offset: ['start end', 'end start'] });`);
    }
    // A prop's responsive set spans every viewport that overrides EITHER endpoint
    // (so e.g. a tablet-only `to` still emits a `from` so the range stays valid).
    const tfResp = tf.responsive ?? [];
    const props = Array.from(new Set([
      ...numProps(tf.from), ...numProps(tf.to),
      ...tfResp.flatMap((r) => [...numProps(r.from ?? {}), ...numProps(r.to ?? {})]),
    ]));
    // Gate one endpoint scalar via the shared `gateScalar` (`(gate ? override : base)`),
    // so Transform endpoints, hover/tap targets, appear FROM and Speed all share one
    // value-responsive path + one `__mqN` per viewport.
    const gateEndpoint = (base: number, which: 'from' | 'to', p: string): string =>
      gateScalar(base, tfResp.map((r) => ({ scope: r.scope, v: r[which]?.[p] })));
    for (const p of props) {
      const from = tf.from[p] ?? baseOf(p);
      const to = tf.to[p] ?? baseOf(p);
      const mv = `${cn}FxTf${Cap(p)}`;
      // Presence wraps the (already per-viewport) endpoint: off-scope BOTH ends collapse
      // to the resting/neutral value → the range is flat → no scrub (effect absent).
      const fromE = gateP('transform', gateEndpoint(from, 'from', p), String(baseOf(p)));
      const toE = gateP('transform', gateEndpoint(to, 'to', p), String(baseOf(p)));
      decls.push(`  const ${mv} = useTransform(${prog}, [0, 1], [${fromE}, ${toE}]);`);
      addMV(p, mv);
    }
  }

  // 2. Compose each prop (folding in any external scroll binding) → one style value.
  const external = readExternalStyleBindings(result, nodeId, cn);
  const styleBindings: Record<string, string> = {};
  const composeLines: string[] = [];
  const allProps = new Set([...Object.keys(propMVs), ...Object.keys(external).filter((p) => propMVs[p])]);
  for (const p of allProps) {
    const mvs = [...(propMVs[p] ?? [])];
    if (external[p]) mvs.unshift(external[p]); // scroll value joins the composition
    if (mvs.length === 1) { styleBindings[p] = mvs[0]; continue; }
    const op = MUL_PROPS.has(p) ? '* v' : '+ v';
    const init = MUL_PROPS.has(p) ? '1' : '0';
    const cvar = `${cn}FxC${Cap(p)}`;
    composeLines.push(`  const ${cvar} = useTransform([${mvs.join(', ')}], (vals) => vals.reduce((a, v) => a ${op}, ${init}));`);
    styleBindings[p] = cvar;
  }

  // 3. Insert decls + composes + effects before the component's return.
  const block = [...decls, ...composeLines, ...effects].join('\n');
  const withHooks = insertBeforeRenderReturn(result, block);
  if (withHooks === null) return code;
  result = withHooks;

  // 4. Bind composed values into the instance `style` + write the spec attr.
  result = setStyleBindings(result, nodeId, styleBindings);
  result = setTagAttr(result, nodeId, 'data-instance-fx', `'${JSON.stringify(spec)}'`);

  if (parseJSX(result) === null) { trace.error('instanceFx.set:parseFailed', { nodeId }); return code; }
  return result;
}

/** Two scopes are equal when they name the same viewport band or variant.
 *  (Delegates to the shared presence module — single definition.) */
const fxScopeEq = scopeEq;

/** The VALUE to show in the editor for an effect endpoint on the active tile:
 *  the base overlaid with the matching scope's override (so editing on Tablet
 *  shows Tablet's value, on Desktop shows the base). scope=null → base only. */
export function resolveTransformValue(
  tf: NonNullable<InstanceFxSpec['transform']>, which: 'from' | 'to', scope: SerScope | null,
): FxProps {
  const base = tf[which] ?? {};
  if (!scope) return { ...base };
  const ov = (tf.responsive ?? []).find((r) => fxScopeEq(r.scope, scope));
  return { ...base, ...(ov?.[which] ?? {}) };
}

/** Write an edit to a transform endpoint for `scope`, KEEPING the base + sibling
 *  overrides. scope=null → set the base; scope=viewport/variant → upsert that
 *  override branch. Pure (spec → spec) so it's unit-testable + reused by the tool. */
export function setTransformValueScoped(
  spec: InstanceFxSpec, which: 'from' | 'to', props: FxProps, scope: SerScope | null,
): InstanceFxSpec {
  const tf = { ...(spec.transform ?? { from: {}, to: {} }) } as NonNullable<InstanceFxSpec['transform']>;
  if (!scope) return { ...spec, transform: { ...tf, [which]: props } };
  const resp = [...(tf.responsive ?? [])];
  const i = resp.findIndex((r) => fxScopeEq(r.scope, scope));
  if (i >= 0) resp[i] = { ...resp[i], [which]: props };
  else resp.push({ scope, [which]: props });
  return { ...spec, transform: { ...tf, responsive: resp } };
}

/** Drop the active scope's transform override (Reset Override). Removes the whole
 *  override entry for that scope; the endpoint(s) fall back to the base. */
export function resetTransformScope(spec: InstanceFxSpec, scope: SerScope): InstanceFxSpec {
  const tf = spec.transform;
  if (!tf?.responsive) return spec;
  const resp = tf.responsive.filter((r) => !fxScopeEq(r.scope, scope));
  const next = { ...tf };
  if (resp.length) next.responsive = resp; else delete next.responsive;
  return { ...spec, transform: next };
}

/** Whether the active scope has a transform override (drives the override dot/Reset). */
export function hasTransformScope(spec: InstanceFxSpec, scope: SerScope | null): boolean {
  if (!scope) return false;
  return (spec.transform?.responsive ?? []).some((r) => fxScopeEq(r.scope, scope));
}

// ── VALUE-responsive helpers for the single-bag effects (hover/tap → `to`, appear →
//    `from`). Mirror the Transform helpers above so the tool wires them identically:
//    editing on a replica upserts that scope's override KEEPING base + siblings, the
//    override dot/Reset read `hasFxValueScope`, Reset drops the active scope's override.
//    Pure (spec → spec), unit-tested in instance-fx.test.ts. Speed has its own pair
//    below (it's a single scalar, not a props bag).
type ValueFxKey = 'hover' | 'tap' | 'appear';
const fxValueField = (key: ValueFxKey): 'to' | 'from' => (key === 'appear' ? 'from' : 'to');

/** The props to show in the editor for `key` on the active tile: base ⊕ this scope's override. */
export function resolveFxValue(spec: InstanceFxSpec, key: ValueFxKey, scope: SerScope | null): FxProps {
  const eff = (spec as any)[key];
  if (!eff) return {};
  const field = fxValueField(key);
  const base: FxProps = eff[field] ?? {};
  if (!scope) return { ...base };
  const ov = (eff.responsive ?? []).find((r: any) => fxScopeEq(r.scope, scope));
  return { ...base, ...(ov?.[field] ?? {}) };
}

/** Write a value edit for `key` at `scope` — base (scope=null) or upsert that override. */
export function setFxValueScoped(spec: InstanceFxSpec, key: ValueFxKey, props: FxProps, scope: SerScope | null): InstanceFxSpec {
  const field = fxValueField(key);
  const eff = { ...((spec as any)[key] ?? { [field]: {} }) };
  if (!scope) return { ...spec, [key]: { ...eff, [field]: props } };
  const resp = [...(eff.responsive ?? [])];
  const i = resp.findIndex((r: any) => fxScopeEq(r.scope, scope));
  if (i >= 0) resp[i] = { ...resp[i], [field]: props };
  else resp.push({ scope, [field]: props });
  return { ...spec, [key]: { ...eff, responsive: resp } };
}

/** Drop the active scope's value override for `key` (Reset Override). */
export function resetFxValueScope(spec: InstanceFxSpec, key: ValueFxKey, scope: SerScope): InstanceFxSpec {
  const eff = (spec as any)[key];
  if (!eff?.responsive) return spec;
  const resp = eff.responsive.filter((r: any) => !fxScopeEq(r.scope, scope));
  const next = { ...eff };
  if (resp.length) next.responsive = resp; else delete next.responsive;
  return { ...spec, [key]: next };
}

/** Whether the active scope has a value override for `key` (override dot/Reset). */
export function hasFxValueScope(spec: InstanceFxSpec, key: ValueFxKey, scope: SerScope | null): boolean {
  if (!scope) return false;
  return ((spec as any)[key]?.responsive ?? []).some((r: any) => fxScopeEq(r.scope, scope));
}

// ── Speed value-responsive (single scalar; `speedResponsive` array). ──
export function resolveSpeedValue(spec: InstanceFxSpec, scope: SerScope | null): number {
  const base = spec.speed ?? 100;
  if (!scope) return base;
  return (spec.speedResponsive ?? []).find((r) => fxScopeEq(r.scope, scope))?.speed ?? base;
}
export function setSpeedScoped(spec: InstanceFxSpec, speed: number, scope: SerScope | null): InstanceFxSpec {
  if (!scope) return { ...spec, speed };
  const resp = [...(spec.speedResponsive ?? [])];
  const i = resp.findIndex((r) => fxScopeEq(r.scope, scope));
  if (i >= 0) resp[i] = { scope, speed }; else resp.push({ scope, speed });
  return { ...spec, speedResponsive: resp };
}
export function resetSpeedScope(spec: InstanceFxSpec, scope: SerScope): InstanceFxSpec {
  if (!spec.speedResponsive) return spec;
  const resp = spec.speedResponsive.filter((r) => !fxScopeEq(r.scope, scope));
  const next = { ...spec };
  if (resp.length) next.speedResponsive = resp; else delete next.speedResponsive;
  return next;
}
export function hasSpeedScope(spec: InstanceFxSpec, scope: SerScope | null): boolean {
  if (!scope) return false;
  return (spec.speedResponsive ?? []).some((r) => fxScopeEq(r.scope, scope));
}

// ── Per-effect PRESENCE — thin wrappers over the SHARED presence module. instance-fx
//    stores each effect's presence under `spec.presence[key]`; these adapt that map
//    slot to/from a `PresenceState`. The state semantics live in presence.ts.
const fxPresence = (spec: InstanceFxSpec, key: FxKey): PresenceState | undefined => spec.presence?.[key];
/** Write `state` (or remove the slot) at `presence[key]`, dropping `presence` when empty. */
const applyFxPresence = (spec: InstanceFxSpec, key: FxKey, state: PresenceState | undefined): InstanceFxSpec => {
  const presence = { ...(spec.presence ?? {}) };
  if (state) presence[key] = state; else delete presence[key];
  const next = { ...spec };
  if (Object.keys(presence).length) next.presence = presence; else delete next.presence;
  return next;
};
/** Drop the effect itself (its key) AND its presence slot — used when a scoped-only
 *  effect loses its last tile. */
const removeFxEffect = (spec: InstanceFxSpec, key: FxKey): InstanceFxSpec => {
  const next = applyFxPresence(spec, key, undefined);
  delete (next as Record<string, unknown>)[key];
  return next;
};

/** Is `key`'s effect present on the given tile? `scope=null` = primary/base. */
export const instanceFxPresentOn = (spec: InstanceFxSpec, key: FxKey, scope: SerScope | null): boolean =>
  presentOn(fxPresence(spec, key), scope);

/** Does this tile carry a presence customization for `key` (added-here / hidden-here)? */
export const instanceFxIsOverride = (spec: InstanceFxSpec, key: FxKey, scope: SerScope | null): boolean =>
  isPresenceOverride(fxPresence(spec, key), scope);

/** Adding on a replica scopes `key` to that tile only; on Desktop/primary = base. */
export function addInstanceFxScope(spec: InstanceFxSpec, key: FxKey, scope: SerScope | null): InstanceFxSpec {
  if (!scope) {
    // Adding on the PRIMARY when the effect was added ONLY on a replica (present-only `scope`):
    // make it present EVERYWHERE by clearing the presence scope. The effect now shows on primary
    // too; the replica keeps its value-override (which only reads as an override — blue dot — if it
    // differs from the base value, otherwise they're identical so nothing flags). Without this,
    // "add on tablet, then add on desktop" no-oped (the effect already existed, just scoped away).
    const p = fxPresence(spec, key);
    return (p?.scope?.length) ? applyFxPresence(spec, key, undefined) : spec;
  }
  return applyFxPresence(spec, key, addPresenceScope(fxPresence(spec, key), scope));
}

/** Delete `key` on a replica (the reference "remove here"). Removes the effect when its last tile. */
export function hideInstanceFxOn(spec: InstanceFxSpec, key: FxKey, scope: SerScope): InstanceFxSpec {
  const r = hidePresenceOn(fxPresence(spec, key), scope);
  return r.remove ? removeFxEffect(spec, key) : applyFxPresence(spec, key, r.state);
}

/** Reset Override for `key` on a replica → back to base, or remove if scoped-only here. */
export function resetInstanceFxScope(spec: InstanceFxSpec, key: FxKey, scope: SerScope): InstanceFxSpec {
  const r = resetPresenceScope(fxPresence(spec, key), scope);
  return r.remove ? removeFxEffect(spec, key) : applyFxPresence(spec, key, r.state);
}

/** Parse a node's instance-fx spec from `data-instance-fx`, or null. */
export function getInstanceFx(code: string, nodeId: string): InstanceFxSpec | null {
  return getJsonAttr<InstanceFxSpec>(code, nodeId, 'data-instance-fx');
}

/** DORMANTIZE for the canvas: a node moved into `canvasNodes` (module scope, NO component body)
 *  can't run the page-level Fx hooks (`useMotionValue`/`useTransform`/`useScroll`/`useEffect`),
 *  and its `style={{ scale: <cn>FxCScale, … }}` motion-value bindings would reference out-of-scope
 *  identifiers → crash. Strip the hooks + bindings + ref, but KEEP the `data-instance-fx` attr so
 *  the effects are fully preserved (standard) and `rehydrateInstanceFx` regenerates them when
 *  the node moves back into a viewport. No-op when there's no instance-fx. */
export function dormantizeInstanceFx(code: string, nodeId: string): string {
  const spec = getInstanceFx(code, nodeId);
  if (!spec) return code;
  const cn = cleanNameOf(nodeId);
  let result = stripInstanceFx(code, nodeId, cn);  // drops hooks + style bindings + ref + the attr
  // Re-attach the spec so it round-trips (rehydrate reads it on re-entry).
  result = setTagAttr(result, nodeId, 'data-instance-fx', `'${JSON.stringify(spec)}'`);
  return result;
}

/** REHYDRATE: regenerate the Fx hooks + style bindings from the preserved `data-instance-fx`
 *  attr (the inverse of dormantize) when a node re-enters a viewport. Idempotent. No-op without
 *  a spec. */
export function rehydrateInstanceFx(code: string, nodeId: string): string {
  const spec = getInstanceFx(code, nodeId);
  return spec ? setInstanceFxInCode(code, nodeId, spec) : code;
}

/** Drop any captured style value that references this node's OWN fx motion values (`var:<cn>Fx…`).
 *  When dragging an instance to the canvas the drag captures the PARSED style map, whose transform
 *  serializes the motion-value bindings as `transform: 'scale(var:<cn>FxCScale) rotate(var:<cn>FxLoopRotate)'`.
 *  After dormantize those identifiers are gone, so that ref is DEAD + invalid CSS — and the Renderer
 *  re-asserting it every cycle FREEZES the live drag (the element stops following the cursor until
 *  mouseup). Returns a copy with each offending value set to `''` (= remove property per the generator
 *  rule); non-referencing values pass through untouched. */
export function stripDeadFxStyleRefs(styles: Record<string, string>, nodeId: string): Record<string, string> {
  const deadRef = `var:${cleanNameOf(nodeId)}Fx`;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(styles)) out[k] = (typeof v === 'string' && v.includes(deadRef)) ? '' : v;
  return out;
}

/** Remove every top-level `name(…);` statement whose balanced span contains `contains`.
 *  Paren-balanced + string-aware, so inline `animate(…, {…});` inside the body can't
 *  terminate the match early and a neighbouring same-named call is left untouched. */
function removeBalancedCall(code: string, name: string, contains: string): string {
  let result = code;
  let from = 0;
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
    while (semi < result.length && /\s/.test(result[semi]) && result[semi] !== '\n') semi++;
    if (result[semi] === ';') semi++;
    if (result.slice(idx, semi).includes(contains)) {
      let start = idx;
      while (start > 0 && (result[start - 1] === ' ' || result[start - 1] === '\t')) start--;
      if (result[start - 1] === '\n') start--;
      result = result.slice(0, start) + result.slice(semi);
      from = start;
    } else {
      from = semi;
    }
  }
  return result;
}

/** Remove every `<cn>Fx…` decl/compose/useEffect, the `<cn>Fx…` style bindings, and the
 *  spec attr. Leaves scroll bindings + the shared ref (ref stripped only if now unused). */
function stripInstanceFx(code: string, nodeId: string, cn: string): string {
  const e = cn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let result = code;
  // Our multi-line `useEffect(…)` (hover/press/appear-mount/loop) and
  // `useMotionValueEvent(…)` (appear onScroll/layerInView) handlers — removed by paren
  // balancing (NOT regex): the bodies contain inline `animate(…, { … });` whose `});`
  // would stop a lazy regex early, leaving the rest of the handler dangling. Balancing
  // also can't bleed into a NEIGHBOURING handler (Scroll Variant's section useEffect /
  // onScroll useMotionValueEvent), so only OUR `<cn>Fx`-referencing calls are dropped.
  result = removeBalancedCall(result, 'useEffect', `${cn}Fx`);
  result = removeBalancedCall(result, 'useMotionValueEvent', `${cn}Fx`);
  // MULTI-LINE destructure (after a babel/AST reformat the `const { scrollY: … } = useScroll(…)`
  // spans several lines, so the per-line filter below MISSES it). Left behind it either
  // DUPLICATES on regen (`Identifier already declared`) or — on delete — dangles its
  // `target: <cn>Ref` after the ref decl is swept ("undefined identifier <cn>Ref"). The
  // `\{[^{}]*?…\}` matches the LHS destructure across newlines; `useScroll\([^)]*\)` covers
  // the `{ target, offset:[…] }` arg (no inner parens). Must run BEFORE the ref-removal below.
  result = result.replace(new RegExp(`\\s*const\\s*\\{[^{}]*?:\\s*${e}Fx\\w*\\s*\\}\\s*=\\s*useScroll\\([^)]*\\);`, 'g'), '');
  // Single-line decls. Plain `const <cn>Fx… = …` (useMotionValue/useTransform) AND
  // DESTRUCTURE forms `const { scrollY: <cn>FxSpeedScroll } = useScroll()` (speed) /
  // `const { scrollYProgress: <cn>FxTfP } = useScroll()` (transform) — without the
  // destructure case the old scroll decls survive a regen and the fresh ones DUPLICATE
  // them (`Identifier already declared`), so the whole regen bails + drops the edit.
  result = result.split('\n').filter((line) => {
    const t = line.trim();
    if (new RegExp(`^const ${e}Fx\\w*\\s*=`).test(t)) return false;
    if (new RegExp(`^const \\{[^}]*:\\s*${e}Fx\\w*\\s*\\}\\s*=`).test(t)) return false;
    return true;
  }).join('\n');
  // Style bindings whose value is one of our vars, + the spec attr.
  result = clearFxStyleBindings(result, nodeId, cn);
  result = setTagAttr(result, nodeId, 'data-instance-fx', null);
  // Drop the shared ref if nothing else uses it (no other ref={cn}Ref consumer / decl ref).
  const refVar = `${cn}Ref`;
  const refUses = (result.match(new RegExp(`\\b${e}Ref\\b`, 'g')) || []).length;
  const onlyDeclAndAttr = refUses <= 2 && !new RegExp(`${e}Ref\\.current`).test(result);
  if (onlyDeclAndAttr) {
    result = result.replace(new RegExp(`\\s*const ${e}Ref = useRef\\(null\\);`), '');
    result = result.replace(new RegExp(`\\s*ref=\\{${e}Ref\\}`), '');
  }
  return result;
}

/** Merge `prop: mvVar` pairs into the instance's `style={{ … }}` (creating it if absent),
 *  replacing any existing binding for the same prop. */
function setStyleBindings(code: string, nodeId: string, bindings: Record<string, string>): string {
  if (!Object.keys(bindings).length) return code;
  const got = getOpeningTag(code, nodeId);
  if (!got) return code;
  let tag = got.tag;
  const m = tag.match(/style=\{\{([\s\S]*?)\}\}/);
  const add = Object.entries(bindings).map(([p, v]) => `${p}: ${v}`).join(', ');
  if (m) {
    // Strip existing entries for these props, then prepend the new ones.
    let inner = m[1];
    for (const p of Object.keys(bindings)) {
      inner = inner.replace(new RegExp(`(^|,)\\s*${p}\\s*:\\s*[^,}]+`), (mm, pre) => (pre === ',' ? '' : ''));
    }
    inner = inner.replace(/^\s*,/, '').trim();
    const merged = inner ? `${add}, ${inner}` : add;
    tag = tag.replace(/style=\{\{[\s\S]*?\}\}/, `style={{ ${merged} }}`);
  } else {
    tag = tag.replace(/^(<[a-zA-Z][\w.]*)/, `$1 style={{ ${add} }}`);
  }
  return code.slice(0, got.tagStart) + tag + code.slice(got.gt);
}

/** Remove `prop: <cn>Fx…` bindings (ours) from the instance `style`. */
function clearFxStyleBindings(code: string, nodeId: string, cn: string): string {
  const got = getOpeningTag(code, nodeId);
  if (!got) return code;
  const m = got.tag.match(/style=\{\{([\s\S]*?)\}\}/);
  if (!m) return code;
  const kept = m[1].split(',')
    .filter((part) => {
      const pm = part.match(/^\s*\w+\s*:\s*([A-Za-z_$][\w$]*)\s*$/);
      return !(pm && pm[1].startsWith(`${cn}Fx`));
    })
    .map((s) => s.trim()).filter(Boolean);
  const tag = kept.length
    ? got.tag.replace(/style=\{\{[\s\S]*?\}\}/, `style={{ ${kept.join(', ')} }}`)
    : got.tag.replace(/\s*style=\{\{[\s\S]*?\}\}/, '');
  return code.slice(0, got.tagStart) + tag + code.slice(got.gt);
}
