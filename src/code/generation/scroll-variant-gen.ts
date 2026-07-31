// scroll-variant-gen.ts — Scroll Variant effect (component instances only).
//
// A component instance is `<Hero initialVariant="default" />` and its root renders
// `animate={initialVariant}` — framer-motion's `animate` reacts to prop changes, so
// feeding a CHANGING `initialVariant` makes the component morph between its variants
// (via its own `variants={}` + MotionConfig transition). Scroll Variant is therefore
// PAGE-LEVEL: it computes a variant name from scroll and binds it to the instance's
// `initialVariant` prop. It's independent of the `data-scroll-fx` motion-value compose,
// so it coexists cleanly with Animation/Speed/Transform/Hover/Tap/Loop on the same
// instance (different mechanism, same scroll).
//
// The editable spec lives in a `data-scroll-variant='<json>'` attribute on the
// instance; the page code is REGENERATED from the spec on every write (set = strip
// old + inject fresh), so the spec is the single source of truth.
import { trace } from '@/shared/debug-trace';
import { nodeIdToVarName } from '@/shared/id-utils';
import { findJSXDataIdIndex, insertBeforeRenderReturn, setTagAttr, getJsonAttr } from './generator-utils';
import { parseJSX } from '@/code/parsing/ast-utils';
import { buildScopedScalarExpr, sweepOrphanMediaGates, type SerScope } from './scoped-expr';
import { presentOn, isPresenceOverride, hidePresenceOn, resetPresenceScope, scopeEq, type PresenceState } from '@/code/animations/presence';

/** A node's opening tag (without trailing `>`), brace/string-aware. */
function getOpeningTagInfo(code: string, nodeId: string): { tag: string; tagStart: number; gt: number } | null {
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

export type ScrollVariantTrigger = 'onScroll' | 'layerInView' | 'sectionInView';

export interface ScrollVariantSpec {
  trigger: ScrollVariantTrigger;
  /** Base variant when the trigger is inactive (and for replay revert). */
  from: string;
  /** The variant displayed on the STATIC canvas — the variant the user had selected when the
   *  Scroll Variant was added (or last changed via the Variant dropdown). INDEPENDENT of
   *  `from`/`to` (which are the runtime scroll morph endpoints): the canvas keeps showing the
   *  user's pick and changing `from`/`to` never repaints it. Absent → canvas falls back to the
   *  component's base/default variant (legacy behavior, preserved for specs without this field). */
  canvasVariant?: string;
  // onScroll (direction-triggered):
  direction?: 'down' | 'up';
  replay?: boolean;
  to?: string;
  /** Per-viewport overrides of the scroll-variant config. Each field falls back to the
   *  base when absent on a scope. Lets e.g. Desktop scroll Down→variant-1 while Tablet
   *  scrolls Up→variant-2. Applies to onScroll + layerInView (`from`/`to`); `direction`
   *  is onScroll-only. `replay` stays a base-level setting. (sectionInView has per-section
   *  targets already, so it ignores `responsive`.) */
  // `fromVar` per scope binds the RESTING variant to a DIFFERENT variable on that
  // viewport (the per-viewport analog of the base `fromVar` below) — so Desktop can
  // bind `headerVariant` while Tablet binds `headerVariantTablet`. Exactly the
  // per-viewport-override model every instance prop uses (`data-responsive`), just
  // stored in the spec because a scroll-variant's runtime variant is the state
  // machine, not `data-responsive`. Falls back to the base `fromVar` when absent.
  responsive?: Array<{ scope: SerScope; from?: string; to?: string; direction?: 'down' | 'up'; fromVar?: string }>;
  // layerInView:
  start?: 'top' | 'center' | 'bottom';
  // sectionInView (multi-section): each page section maps to a target variant.
  viewport?: 'top' | 'middle' | 'bottom';
  // `sectionVar` (optional) binds the target to a TEMPLATE VARIABLE (a
  // LayoutClient param) instead of a literal `sectionId` — so a template can
  // target a DIFFERENT page section per page. Runtime resolves
  // `getElementById(sectionVar)` (the var is reassigned per-route via
  // usePathname); `sectionId` is kept as the authoring default + anchor-picker value.
  sections?: { sectionId: string; to: string; sectionVar?: string }[];
  // `fromVar` (optional) binds the RESTING / STARTING variant to a variable
  // (a LayoutClient/component param) — the analog of `sectionVar` for the
  // resting state. When set, the machine starts at `fromVar || <per-viewport
  // resting>`, so per route (template prop) the user picks the start variant:
  // set it to the scroll TARGET → the effect is invisible (already there); set
  // it to a different variant → the effect plays. The binding + scroll target
  // are untouched, so the scroll effect ALWAYS runs — only the start moves.
  // Empty/unset → falls through to the per-viewport resting (current behavior).
  fromVar?: string;
  // ── Per-viewport PRESENCE (the reference 3-state). Absent/empty `scope` + empty
  //    `hiddenOn` = runs everywhere (base). These gate the `initialVariant` BINDING,
  //    so off-scope the instance stays at `from` (no morph) — trigger-agnostic.
  /** Present ONLY on these viewports (added on a replica → absent on primary). */
  scope?: SerScope[];
  /** A base effect turned OFF on these viewports (deleted on a replica). */
  hiddenOn?: SerScope[];
}

const cleanNameOf = nodeIdToVarName;
const q = (s: string) => `'${s}'`;
// layerInView trigger line, as a fraction of viewport height: the variant flips to
// `to` once the element's TOP edge scrolls up past this line. top→0 (the element's top
// actually reaches the viewport top), center→0.5 (the middle), bottom→1 (the element
// first enters from the viewport bottom).
const LINE_FRACTION: Record<string, number> = { top: 0, center: 0.5, middle: 0.5, bottom: 1 };

/** The page-level lines + the `initialVariant` binding value the spec generates.
 *  `refVar` is set for layerInView — the instance gets `ref={refVar}` (React 19: a
 *  plain ref prop flows through withResponsiveProps to the component, which attaches
 *  it to its root). */
function buildScrollVariant(code: string, cn: string, spec: ScrollVariantSpec): { code: string; lines: string[]; bind: string; refVar?: string } {
  const sv = `${cn}Sv`;
  let result = code;
  const resp = spec.responsive ?? [];
  const baseFrom = spec.from;
  const baseTo = spec.to ?? spec.from;
  const baseDir = spec.direction ?? 'down';

  // Resting-with-variable: when a `fromVar` is bound, the STARTING/resting variant
  // becomes `<fromVar> || (<per-viewport resting>)` — the var overrides the start
  // per route, falling through to the responsive resting when empty/unset. Wraps
  // ONLY the resting sites (useState init, resize-reset, the not-triggered value);
  // the scroll TARGETS (to/down/up) are never wrapped, so the effect always runs.
  //
  // PER-VIEWPORT: the binding itself is per-viewport — Desktop binds the base
  // `spec.fromVar`; a replica binds its own `responsive[scope].fromVar`. So the
  // fromVar half is ITSELF a `__mq`-gated scalar (variable identifiers, unquoted) →
  // `(__mq1 ? headerVariantMobile : __mq0 ? headerVariantTablet : headerVariant) || (<resting>)`.
  // Base-only collapses to the bare `spec.fromVar ||`; no fromVar at all → no wrap —
  // so existing scroll variants are byte-identical.
  let fromVarExpr: string | null = null;
  {
    const baseVar = spec.fromVar ?? null;
    // A `fromVar` KEY present (even '') is an EXPLICIT per-viewport binding: a name → bind that
    // variable on the tile; '' → explicitly NO variable (the tile falls to its resting, NOT the
    // cascaded base). Undefined → no per-viewport override (the base cascades).
    const vpFromVars = resp
      .map((r) => ({ scope: r.scope, v: r.fromVar }))
      .filter((o): o is { scope: SerScope; v: string } => o.v !== undefined && o.v !== null);
    if (baseVar || vpFromVars.length) {
      // '' renders as the empty-string literal (`(__mq ? '' : baseVar)` → `'' || resting`).
      const ovs = vpFromVars.filter((o) => o.v !== baseVar).map((o) => ({ scope: o.scope, value: o.v === '' ? "''" : o.v }));
      if (!ovs.length) {
        fromVarExpr = baseVar; // only a base binding → bare identifier
      } else {
        // No base binding but per-viewport ones → Desktop falls through to '' (resting only).
        const built = buildScopedScalarExpr(result, baseVar ?? "''", ovs);
        result = built.code;
        fromVarExpr = built.expr;
      }
    }
  }
  const restVar = (expr: string): string => (fromVarExpr ? `${fromVarExpr} || (${expr})` : expr);

  // The resting variant is bound to TEMPLATE VARIABLES (`spec.fromVar` + per-viewport `responsive[].fromVar`,
  // e.g. headerVariant/tabletVariant/mobileVariant) that a LayoutClient REASSIGNS per route via usePathname.
  // The reset useEffect below must list them as deps so it re-runs on a SOFT (SPA) navigation — otherwise the
  // header stays on the previous page's variant until the next scroll event (visible only when you navigate
  // from the TOP of a page, where no scroll fires to recompute it). Same soft-nav class as the live
  // getElementById section re-query above. Derive the names from `fromVarExpr` (the actual resting expression)
  // so the deps EXACTLY match what the effect body reads — every identifier in it except the `__mq` gates
  // (already added below as gateVars). Null fromVarExpr (no variable binding) → no extra deps.
  const fromVarDeps = fromVarExpr
    ? [...new Set(fromVarExpr.match(/[A-Za-z_$][\w$]*/g) ?? [])].filter((id) => !/^__mq\d+$/.test(id))
    : [];

  // Gate a per-viewport variant NAME: `(__mq0 ? 'variant-2' : 'variant-1')`. `pick(r)`
  // returns the override value for a scope (or undefined → falls back to base). An override
  // equal to base is pruned, so no overrides ⇒ bare base ⇒ zero regression. Reuses the SAME
  // buildScopedScalarExpr/gate consts as every other responsive effect; quoted names are scalars.
  const gateName = (baseName: string, pick: (r: typeof resp[number]) => string | undefined): string => {
    const ovs = resp
      .map((r) => ({ scope: r.scope, v: pick(r) }))
      .filter((o): o is { scope: SerScope; v: string } => !!o.v && o.v !== baseName)
      .map((o) => ({ scope: o.scope, value: q(o.v) }));
    if (!ovs.length) return q(baseName);
    const built = buildScopedScalarExpr(result, q(baseName), ovs);
    result = built.code;
    return built.expr;
  };
  // direction just decides which target is the scroll-DOWN one vs the revert (UP) one, so
  // per-viewport direction/from/to all reduce to per-viewport down/up TARGET names — no
  // handler branching needed. `replay` stays base-level (the revert line is emitted or not).
  const downName = (r: { from?: string; to?: string; direction?: 'down' | 'up' }) =>
    (r.direction ?? baseDir) === 'up' ? (r.from ?? baseFrom) : (r.to ?? baseTo);
  const upName = (r: { from?: string; to?: string; direction?: 'down' | 'up' }) =>
    (r.direction ?? baseDir) === 'up' ? (r.to ?? baseTo) : (r.from ?? baseFrom);

  if (spec.trigger === 'onScroll') {
    const Cn = cn.charAt(0).toUpperCase() + cn.slice(1);
    const setter = `set${Cn}Sv`;
    const initExpr = gateName(baseFrom, (r) => r.from);          // resting (gated per tile)
    const downExpr = gateName(downName(spec), (r) => downName(r));
    const upExpr = gateName(upName(spec), (r) => upName(r));
    const lines = [
      `  const [${sv}, ${setter}] = useState(${restVar(initExpr)});`,
      `  const { scrollY: ${sv}Scroll } = useScroll();`,
      `  useMotionValueEvent(${sv}Scroll, "change", (y) => {`,
      `    const prev = ${sv}Scroll.getPrevious() ?? 0;`,
      `    if (y > prev) ${setter}(${downExpr});`,
      ...(spec.replay !== false ? [`    else if (y < prev) ${setter}(${restVar(upExpr)});`] : []),
      `  });`,
    ];
    // The handler only fires on SCROLL, so crossing a breakpoint by RESIZE leaves `sv`
    // stale (the previous tile's variant). Reset to this tile's resting `from` when a gate
    // flips, so it re-evaluates per the new tile. (Same adaptive reset as normal-node Direction.)
    const gateVars = [...new Set(lines.join('\n').match(/__mq\d+/g) ?? [])];
    const resetDeps = [...new Set([...gateVars, ...fromVarDeps])];
    if (resetDeps.length) lines.push(`  useEffect(() => { ${setter}(${restVar(initExpr)}); }, [${resetDeps.join(', ')}]);`);
    return { code: result, lines, bind: sv };
  }

  if (spec.trigger === 'layerInView') {
    const to = gateName(baseTo, (r) => r.to);
    const fromGated = gateName(baseFrom, (r) => r.from);
    const frac = LINE_FRACTION[spec.start ?? 'center'];
    // Drive off `useScroll` (same proven path as On Scroll) + the element's real
    // viewport rect — robust to the preview's scroll/scale, unlike a percentage
    // IntersectionObserver rootMargin. The ref is attached to the instance and
    // forwarded to the component root via ensureComponentAcceptsRef. Initial state is
    // `from`; the first scroll tick settles it (so it never flips on load).
    const Cn = cn.charAt(0).toUpperCase() + cn.slice(1);
    const setter = `set${Cn}Sv`;
    // top → `<= 0` (touches the viewport top); else `<= innerHeight * frac`.
    const threshold = frac === 0 ? '0' : `window.innerHeight * ${frac}`;
    const onPast = spec.replay !== false
      ? `      ${setter}(past ? ${to} : ${restVar(fromGated)});`
      : `      if (past) ${setter}(${to});`;
    const lines = [
      `  const ${sv}Ref = useRef(null);`,
      `  const [${sv}, ${setter}] = useState(${restVar(fromGated)});`,
      `  const { scrollY: ${sv}ScrollY } = useScroll();`,
      `  useMotionValueEvent(${sv}ScrollY, "change", () => {`,
      `    const el = ${sv}Ref.current;`,
      `    if (el) {`,
      `      const past = el.getBoundingClientRect().top <= ${threshold};`,
      onPast,
      `    }`,
      `  });`,
    ];
    // Reset on resize so the gated from/to re-evaluate when a breakpoint flips (see onScroll).
    const gateVars = [...new Set(lines.join('\n').match(/__mq\d+/g) ?? [])];
    const resetDeps = [...new Set([...gateVars, ...fromVarDeps])];
    if (resetDeps.length) lines.push(`  useEffect(() => { ${setter}(${restVar(fromGated)}); }, [${resetDeps.join(', ')}]);`);
    return { code: result, lines, bind: sv, refVar: `${sv}Ref` };
  }

  // sectionInView (the reference "Section in View") — POSITION-based: a section's `to` applies once
  // that section's TOP edge has scrolled ABOVE the chosen viewport line; otherwise the
  // per-viewport resting `from`. Later sections win (checked last → overwrite). Recomputed on
  // every scroll tick via useScroll. Matches the reference: anchored to the hero with Viewport=Top,
  // the header darkens once you scroll past the hero's top and reverts ONLY at the very top.
  // (The old `useInView` INTERSECTION fired WHILE the section was on screen — so a hero anchor
  // darkened AT the top and cleared after, the inverse of what's wanted.)
  const restingGated = gateName(spec.from, (r) => r.from);   // per-viewport resting: desktop 'default', mobile 'mobile', …
  const frac = LINE_FRACTION[spec.viewport ?? 'middle'];     // top:0 center:0.5 bottom:1
  const lineExpr = frac === 0 ? '0' : `window.innerHeight * ${frac}`;
  const Cn = cn.charAt(0).toUpperCase() + cn.slice(1);
  const setter = `set${Cn}Sv`;
  const secs = spec.sections ?? [];
  const lines: string[] = [
    `  const { scrollY: ${sv}ScrollY } = useScroll();`,
    `  const [${sv}, ${setter}] = useState(${restVar(restingGated)});`,
  ];
  // Resolve the target element INSIDE the scroll handler (re-query every tick) rather
  // than caching it in a ref on mount. Two reasons this MUST be live, not cached:
  //   1. A template's section lives on the PAGE (inside `{children}`), and that subtree
  //      REMOUNTS on every client-side navigation while the template LayoutClient itself
  //      persists. A mount-time ref would keep pointing at the PREVIOUS page's (now
  //      detached) element — a detached node reports top:0, so the variant silently stops
  //      switching after a soft nav (worked on hard load, dead after clicking a link).
  //   2. A `sectionVar` (template variable) is route-resolved via usePathname; two routes
  //      reusing the SAME anchor name means a name-keyed effect never re-runs to re-grab it.
  // getElementById is an O(1) hash lookup, so per-tick is cheap (the handler already calls
  // getBoundingClientRect). A `sectionVar` is read as an identifier; a literal id is quoted.
  // Later sections overwrite earlier ones, so the LAST passed section wins. The target is
  // PER-VIEWPORT gated (base `to` ⊕ this scope's `responsive[].to`) — same as Scroll Transform.
  lines.push(`  useMotionValueEvent(${sv}ScrollY, "change", () => {`);
  lines.push(`    let v = ${restVar(restingGated)};`);
  secs.forEach((s, i) => {
    const idExpr = s.sectionVar ? s.sectionVar : q(s.sectionId);
    const toExpr = gateName(s.to, (r) => r.to);
    lines.push(`    const ${sv}Sec${i}El = document.getElementById(${idExpr});`);
    lines.push(`    if (${sv}Sec${i}El && ${sv}Sec${i}El.getBoundingClientRect().top < ${lineExpr}) v = ${toExpr};`);
  });
  lines.push(`    ${setter}(v);`);
  lines.push(`  });`);
  // Resize reset so the gated resting re-evaluates when a breakpoint flips.
  const gateVars = [...new Set(lines.join('\n').match(/__mq\d+/g) ?? [])];
  const resetDeps = [...new Set([...gateVars, ...fromVarDeps])];
  if (resetDeps.length) lines.push(`  useEffect(() => { ${setter}(${restVar(restingGated)}); }, [${resetDeps.join(', ')}]);`);
  return { code: result, lines, bind: sv };
}

/** Gate the `initialVariant` bind for per-viewport presence. `svVar` is the computed
 *  variant (present); `fromExpr` is the resting variant (absent). Returns the bind
 *  expression + the code with any `useMediaQuery` gates injected.
 *   - `scope` set   → present ONLY there: base = from, override[vp] = Sv  →  `(__mq ? Sv : 'from')`
 *   - `hiddenOn` set → off there:          base = Sv,   override[vp] = from →  `(__mq ? 'from' : Sv)`
 *   - neither        → bare `Sv` (runs everywhere). */
function buildPresenceBind(
  code: string, svVar: string, fromExpr: string, spec: ScrollVariantSpec,
): { code: string; expr: string } {
  const scope = spec.scope ?? [];
  const hidden = spec.hiddenOn ?? [];
  if (scope.length) {
    return buildScopedScalarExpr(code, fromExpr, scope.map((s) => ({ scope: s, value: svVar })));
  }
  if (hidden.length) {
    return buildScopedScalarExpr(code, svVar, hidden.map((s) => ({ scope: s, value: fromExpr })));
  }
  return { code, expr: svVar };
}

// ── Per-viewport PRESENCE — thin wrappers over the SHARED presence module. The
//    Scroll Variant spec stores its single effect's presence at the TOP level
//    (`spec.scope` / `spec.hiddenOn`); these adapt that to/from a `PresenceState`.
const svPresence = (spec: ScrollVariantSpec): PresenceState => ({ scope: spec.scope, hiddenOn: spec.hiddenOn });
const applyPresence = (spec: ScrollVariantSpec, state: PresenceState | undefined): ScrollVariantSpec => {
  const { scope, hiddenOn, ...rest } = spec;
  const next: ScrollVariantSpec = { ...rest };
  if (state?.scope?.length) next.scope = state.scope;
  if (state?.hiddenOn?.length) next.hiddenOn = state.hiddenOn;
  return next;
};

/** Is the effect present on the given tile? `scope=null` = the primary/base tile. */
export const scrollVariantPresentOn = (spec: ScrollVariantSpec, scope: SerScope | null): boolean =>
  presentOn(svPresence(spec), scope);

/** Does this tile carry a presence customization (drives the override dot + Reset)? */
export const scrollVariantIsOverride = (spec: ScrollVariantSpec, scope: SerScope | null): boolean =>
  isPresenceOverride(svPresence(spec), scope);

/** Delete on a replica (the reference "remove here"). Returns null to remove the effect. */
export function hideScrollVariantOn(spec: ScrollVariantSpec, scope: SerScope): ScrollVariantSpec | null {
  const r = hidePresenceOn(svPresence(spec), scope);
  return r.remove ? null : applyPresence(spec, r.state);
}

/** Reset Override on a replica → back to base, or null if it was scoped-only here. */
export function resetScrollVariantScope(spec: ScrollVariantSpec, scope: SerScope): ScrollVariantSpec | null {
  const r = resetPresenceScope(svPresence(spec), scope);
  // Also drop this tile's per-viewport TARGET override (so Reset clears both presence
  // and a different-target-here, back to the base target).
  const cleared = r.remove ? null : applyPresence(resetScrollVariantTargetScope(spec, scope), r.state);
  return cleared;
}

// ── Per-viewport scroll-variant CONFIG (from/to/direction). Pure spec helpers, mirrored
//    on the gesture/transform value helpers. `replay`/`trigger` stay base-level. ──
type SvConfig = { from: string; to: string; direction: 'down' | 'up' };

/** The config to show in the editor on the active tile: base ⊕ this scope's override. */
export function resolveScrollVariantConfig(spec: ScrollVariantSpec, scope: SerScope | null): SvConfig {
  const base: SvConfig = { from: spec.from, to: spec.to ?? spec.from, direction: spec.direction ?? 'down' };
  if (!scope) return base;
  const ov = (spec.responsive ?? []).find((r) => scopeEq(r.scope, scope));
  return { from: ov?.from ?? base.from, to: ov?.to ?? base.to, direction: ov?.direction ?? base.direction };
}
/** Write a from/to/direction edit: base (scope=null) or upsert that scope's override,
 *  keeping siblings + the scope's other fields. */
export function setScrollVariantFieldScoped(
  spec: ScrollVariantSpec, patch: Partial<SvConfig>, scope: SerScope | null,
): ScrollVariantSpec {
  if (!scope) return { ...spec, ...patch };
  const resp = [...(spec.responsive ?? [])];
  const i = resp.findIndex((r) => scopeEq(r.scope, scope));
  if (i >= 0) resp[i] = { ...resp[i], ...patch };
  else resp.push({ scope, ...patch });
  return { ...spec, responsive: resp };
}
/** sectionInView per-tile TARGET. The section's base lives in `sections[i].to`; a per-viewport
 *  override lives in `responsive[scope].to` (flat — meant for the single-section header pattern,
 *  same shape Scroll Transform uses). Resolve = base ⊕ this scope's override. */
export function resolveSectionTarget(spec: ScrollVariantSpec, sectionIndex: number, scope: SerScope | null): string {
  const base = spec.sections?.[sectionIndex]?.to ?? '';
  if (!scope) return base;
  return (spec.responsive ?? []).find((r) => scopeEq(r.scope, scope))?.to ?? base;
}
/** Write a sectionInView target for the active tile: base `sections[i].to` on the primary, or
 *  `responsive[scope].to` on a replica (keeping the scope's resting `from` + siblings). */
export function setSectionTargetScoped(spec: ScrollVariantSpec, sectionIndex: number, to: string, scope: SerScope | null): ScrollVariantSpec {
  if (!scope) {
    const sections = (spec.sections ?? []).map((s, j) => (j === sectionIndex ? { ...s, to } : s));
    return { ...spec, sections };
  }
  return setScrollVariantFieldScoped(spec, { to }, scope);
}

/** Drop the active scope's whole config override (Reset Override). */
function resetScrollVariantTargetScope(spec: ScrollVariantSpec, scope: SerScope): ScrollVariantSpec {
  if (!spec.responsive) return spec;
  const resp = spec.responsive.filter((r) => !scopeEq(r.scope, scope));
  const next = { ...spec };
  if (resp.length) next.responsive = resp; else delete next.responsive;
  return next;
}
/** Whether the active scope has any config override (override dot/Reset). */
export function hasScrollVariantTargetScope(spec: ScrollVariantSpec, scope: SerScope | null): boolean {
  if (!scope) return false;
  const r = (spec.responsive ?? []).find((x) => scopeEq(x.scope, scope));
  if (!r) return false;
  // A real user OVERRIDE carries a per-tile `to` or `direction`. A `from`-only entry is just the
  // RESTING variant migratePerViewportResting seeded from the per-viewport choice — NOT an override
  // (so the dot clears + Reset Override works after the migration re-adds the resting `from`).
  return r.to !== undefined || r.direction !== undefined;
}

/** Set / replace / remove (`spec = null`) a node's Scroll Variant. Regenerates the
 *  page-level code from the spec and binds `initialVariant` (+ `ref` for layerInView). */
/** DORMANTIZE for the canvas: a node moved into `canvasNodes` (module scope, NO component body)
 *  can't run the page-level `Sv` hooks, and its `initialVariant={…Sv}` binding would reference an
 *  out-of-scope identifier → "undefined identifier" crash. Strip the hooks + bind a STATIC resting
 *  variant, but KEEP the `data-scroll-variant` attr so the effect is fully preserved (standard)
 *  and `rehydrateScrollVariant` can regenerate it when the node moves back into a viewport. No-op
 *  when there's no scroll variant. */
export function dormantizeScrollVariant(code: string, nodeId: string): string {
  const spec = getScrollVariant(code, nodeId);
  if (!spec) return code;
  const cn = cleanNameOf(nodeId);
  let result = stripScrollVariant(code, nodeId, cn);   // removes hooks + the {Sv} binding + the attr
  // Re-attach the spec (so it round-trips) + a static resting variant for the canvas display.
  result = setInstanceAttrs(result, nodeId, {
    'data-scroll-variant': `'${JSON.stringify(spec)}'`,
    // Static resting variant for the dormant canvas node: the user's display pick
    // (`canvasVariant`) if set, else the scroll `from`.
    initialVariant: `"${spec.canvasVariant ?? spec.from}"`,
  });
  return result;
}

/** REHYDRATE: regenerate the scroll-variant hooks + `initialVariant={…Sv}` binding from the
 *  preserved `data-scroll-variant` attr (the inverse of dormantize) when a node re-enters a
 *  viewport. Idempotent — re-running on an already-live node just regenerates. No-op without a spec. */
export function rehydrateScrollVariant(code: string, nodeId: string): string {
  const spec = getScrollVariant(code, nodeId);
  return spec ? setScrollVariantInCode(code, nodeId, spec) : code;
}

export function setScrollVariantInCode(code: string, nodeId: string, spec: ScrollVariantSpec | null): string {
  trace.fn('scrollVariant.set', { nodeId, trigger: spec?.trigger ?? 'remove' });
  const cn = cleanNameOf(nodeId);
  // REMOVAL: strip the scroll machinery. `data-responsive` was never touched, so per-viewport
  // picks are intact. But the single-viewport display choice lived in the spec's `canvasVariant`
  // (the scroll binding OWNED initialVariant) — restore it to a literal `initialVariant="X"` so
  // the canvas keeps showing the user's pick instead of reverting to the component default.
  const removing = !spec;
  const prevCanvasVariant = removing ? getScrollVariant(code, nodeId)?.canvasVariant : undefined;
  let result = stripScrollVariant(code, nodeId, cn);
  if (!spec) {
    if (prevCanvasVariant && prevCanvasVariant !== 'default') {
      result = setInstanceAttrs(result, nodeId, { initialVariant: `"${prevCanvasVariant}"` });
    }
    // Removing the variant can orphan the gate consts it created (no other feature
    // referencing them) — sweep so deleting an effect leaves no dead useMediaQuery.
    return sweepOrphanMediaGates(result);
  }

  // Seed the Sv's per-tile RESTING from the instance's per-viewport variant choice
  // (data-responsive initialVariant) → the spec's per-scope `from`, so the Sv rests at the same
  // variant each tile displays. READ-ONLY: data-responsive is never modified (the canvas + the
  // dropdown keep owning it). The runtime morph wins because the HOC skips `initialVariant` from
  // its per-viewport merge when `data-scroll-variant` is present (see withResponsiveProps).
  spec = migratePerViewportResting(result, nodeId, spec);

  // buildScrollVariant may inject useMediaQuery gate consts (for a per-viewport target);
  // those land at the TOP of the component body, so they precede the inserted lines.
  const built = buildScrollVariant(result, cn, spec);
  result = built.code;
  const { lines, bind, refVar } = built;
  // Insert the page-level lines just before the component's `return (`.
  const withHooks = insertBeforeRenderReturn(result, lines.join('\n'));
  if (withHooks === null) return code;
  result = withHooks;

  // Per-viewport PRESENCE: gate the BIND value (trigger-agnostic). Off-scope the
  // instance resolves to `from` (no morph) → effectively absent. The Sv machinery
  // still runs everywhere (harmless), only the binding is gated.
  const presence = buildPresenceBind(result, bind, q(spec.from), spec);
  result = presence.code;

  // Add `initialVariant={<bind>}` + `ref={…}` (layerInView only) + the spec attr.
  const json = JSON.stringify(spec);
  const attrs: Record<string, string | null> = {
    initialVariant: `{${presence.expr}}`,
    'data-scroll-variant': `'${json}'`,
  };
  // Only manage the ref when the variant ITSELF needs one (layerInView → `${cn}SvRef`).
  // When it doesn't (onScroll/sectionInView), LEAVE any existing ref untouched —
  // instance-fx attaches its OWN `ref={${cn}Ref}` for hover/press and its scroll-
  // transform `useScroll({ target })`. Passing `ref: null` here would strip THAT ref,
  // leaving the target unhydrated → "Target ref is defined but not hydrated" crash
  // (it only surfaced when the variant was added AFTER the instance-fx effects).
  if (refVar) attrs.ref = `{${refVar}}`;
  result = setInstanceAttrs(result, nodeId, attrs);
  // We DON'T touch `data-responsive` — the per-viewport variant CHOICE stays there (drives the
  // canvas + the InitialVariant dropdown + survives delete). The scroll morph still wins at
  // runtime because the `withResponsiveProps` HOC skips `initialVariant` from its per-viewport
  // merge whenever `data-scroll-variant` is present (the Sv binding owns it). The migration above
  // only READS data-responsive to seed the Sv's per-tile RESTING (`from`); it never mutates it.
  // Sweep gate consts the PREVIOUS spec left behind (e.g. a `min-width` resting query no longer
  // referenced after migratePerViewportResting switched to capped `max-width`) so a regen never
  // accretes dead `useMediaQuery` lines (the live `__mq0 = (min-width: 376px)` orphan).
  return sweepOrphanMediaGates(result);
}

/** Fold the instance's per-viewport variant choice (`data-responsive` `initialVariant`) into
 *  the scroll spec's per-scope `from` (the per-tile RESTING), so the Sv can own initialVariant
 *  without losing the per-tile variants. Only fills a scope/base the spec doesn't already set —
 *  never clobbers the user's explicit From. Returns the (possibly augmented) spec. */
function migratePerViewportResting(code: string, nodeId: string, spec: ScrollVariantSpec): ScrollVariantSpec {
  const parsed = getJsonAttr<Record<string, unknown>>(code, nodeId, 'data-responsive');
  if (!parsed) return spec;
  const bp = Array.isArray(parsed._bp) ? (parsed._bp as unknown[]).map(Number).filter((n) => !isNaN(n)) : [];
  if (!bp.length) return spec;
  // `data-responsive` lists ONLY the non-primary (replica) viewports — the PRIMARY
  // (desktop) viewport is implicit and is NOT a key here; it rests at the component's
  // primary variant ('default'). So the BASE resting is 'default' and EVERY listed
  // width is a per-viewport resting OVERRIDE keyed by a CAPPED `(max-width: Wpx)` query.
  //
  // Two bugs this replaces:
  //   1. The old code took the LARGEST listed breakpoint (e.g. 768) as the "primary"
  //      and set the base `from` to ITS variant ('mobile') — so the desktop instance
  //      initialized to the mobile variant.
  //   2. It then keyed the per-viewport override via viewportSetToQuery, which (because
  //      the primary desktop width isn't in this list) gave the TOP breakpoint an
  //      UNBOUNDED `(min-width: 376px)` query — and that ALSO matches desktop (1440 ≥
  //      376), so desktop STILL resolved to 'mobile'. `(max-width: Wpx)` matches only
  //      viewports ≤ W; the primary (wider than every breakpoint) matches none → 'default'.
  //      This also matches the @media convention the rest of the responsive system uses.
  const restingByQuery = new Map<string, string>();
  for (const [k, v] of Object.entries(parsed)) {
    if (k === '_bp') continue;
    const W = Number(k);
    const iv = (v as { initialVariant?: unknown })?.initialVariant;
    if (isNaN(W) || typeof iv !== 'string') continue;
    restingByQuery.set(`(max-width: ${W}px)`, iv);
  }
  if (!restingByQuery.size) return spec;

  // Keep the user's per-tile from/to/direction overrides; DROP migrate-managed resting
  // entries (from-only) so a stale / wrongly-keyed one from an older run can't linger
  // and re-break it. Then (re)seed the resting `from` per breakpoint.
  const responsive = (spec.responsive ?? []).filter((r) => r.to !== undefined || r.direction !== undefined);
  for (const [query, iv] of restingByQuery) {
    const existing = responsive.find((r) => 'query' in r.scope && r.scope.query === query);
    if (existing) { if (existing.from == null) existing.from = iv; }
    else responsive.push({ scope: { query }, from: iv });
  }
  // For onScroll AND sectionInView the From IS the resting (no user-facing From field), so
  // set the base authoritatively to the primary 'default' (also corrects specs a prior buggy
  // run left with a wrong base). Only layerInView keeps the user's explicit From.
  const next: ScrollVariantSpec = { ...spec };
  if (spec.trigger !== 'layerInView') next.from = 'default';
  if (responsive.length) next.responsive = responsive; else delete next.responsive;
  return next;
}

/** Remove every page-level `<cn>Sv…` decl, its useEffect/useMotionValueEvent, the
 *  `initialVariant={…Sv}` binding, and the `data-scroll-variant` attr. */
function stripScrollVariant(code: string, nodeId: string, cn: string): string {
  const cnE = cn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let result = code;
  // Multi-line effects first (useEffect / useMotionValueEvent referencing <cn>Sv).
  result = result.replace(new RegExp(`\\s*useMotionValueEvent\\(${cnE}Sv[\\s\\S]*?\\}\\);`, 'g'), '');
  result = result.replace(new RegExp(`\\s*useEffect\\(\\(\\) => \\{[^\\n]*${cnE}Sv[^\\n]*\\}, \\[[^\\]]*\\]\\);`, 'g'), '');
  // LEGACY-form cleanup (older files; the current generator resolves the section live inside the
  // handler, no ref). sectionInView used to emit, per section, either a `const <cn>SvSecNInView =
  // useInView(<cn>SvSecNRef, { margin: '…' })` or a `useEffect(() => { <cn>SvSecNRef.current =
  // getElementById(<id>); }, [<deps>])`. After a babel reformat BOTH span multiple lines, so the
  // single-line filter above (`[^\n]*`) misses them and they survive — leaving a dangling
  // `<cn>SvSecNRef` reference after its `const` is stripped ("References undefined identifier …
  // would crash"). Strip the whole multi-line forms here. CRITICAL: the deps are `[<anything>]`,
  // NOT just `[]` — a section bound to a TEMPLATE VARIABLE has `[scrollSection3]`, so an empty-only
  // `\[\s*\]` left that effect behind and blocked both remove AND re-apply. Match any deps. The
  // useEffect body is exactly one `.current =` statement, so anchor `{` directly to the ref (no
  // leading `[\s\S]*?`) — a lazy gap would leak across a preceding unrelated useEffect (the trap).
  result = result.replace(new RegExp(`\\s*const\\s+${cnE}Sv\\w*\\s*=\\s*useInView\\([\\s\\S]*?\\}\\);`, 'g'), '');
  result = result.replace(new RegExp(`\\s*useEffect\\(\\(\\)\\s*=>\\s*\\{\\s*${cnE}Sv\\w*Ref\\.current[^;]*;\\s*\\}\\s*,\\s*\\[[^\\]]*\\]\\);`, 'g'), '');
  // The reset-on-resize effect `useEffect(() => { set<Cap>Sv(…); }, [__mqN]);` references
  // ONLY the CAPITALISED setter (`setFrameX…Sv`), not the lowercase-initial `<cn>Sv`, so the
  // line above misses it — and it PILED UP (one per edit) → multiple resets fighting. Strip
  // it by the capitalised setter. (Same capitalisation trap as the normal-node Direction reset.)
  const capE = (cn.charAt(0).toUpperCase() + cn.slice(1)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  result = result.replace(new RegExp(`\\s*useEffect\\(\\(\\)\\s*=>\\s*\\{\\s*set${capE}Sv\\([^;]*\\);\\s*\\},\\s*\\[[^\\]]*\\]\\);`, 'g'), '');
  // MULTI-LINE destructure `const { scrollY: <cn>SvScroll } = useScroll();` — after a babel
  // reformat it spans several lines, so the per-line filter below MISSES it and the fresh
  // regen DUPLICATES it ("Identifier '<cn>SvScroll' already declared"). Match across newlines.
  result = result.replace(new RegExp(`\\s*const\\s*\\{[^{}]*?:\\s*${cnE}Sv\\w*\\s*\\}\\s*=\\s*useScroll\\([^)]*\\);`, 'g'), '');
  // Single-line decls + destructures + useState referencing <cn>Sv.
  result = result.split('\n').filter((line) => {
    const t = line.trim();
    if (new RegExp(`^const ${cnE}Sv\\w*\\s*=`).test(t)) return false;
    if (new RegExp(`^const \\[${cnE}Sv\\b`).test(t)) return false;
    if (new RegExp(`^const \\{[^}]*:\\s*${cnE}Sv\\w*\\s*\\}\\s*=`).test(t)) return false;
    return true;
  }).join('\n');
  // The instance attrs. Strip the variant's OWN ref (`${cn}SvRef`, layerInView) only
  // when instance-fx isn't also on this instance — instance-fx owns a separate
  // `ref={${cn}Ref}` for its gestures/transform target, and removing the variant must
  // not strip THAT (same hydration crash as above).
  const info = getOpeningTagInfo(result, nodeId);
  const keepRef = info ? /\bdata-instance-fx=/.test(info.tag) : false;
  const stripAttrs: Record<string, string | null> = { initialVariant: null, 'data-scroll-variant': null };
  if (!keepRef) stripAttrs.ref = null;
  result = setInstanceAttrs(result, nodeId, stripAttrs);
  return result;
}

/** Add / replace / remove (`value = null`) attributes on a node's opening tag. */
function setInstanceAttrs(code: string, nodeId: string, attrs: Record<string, string | null>): string {
  let result = code;
  for (const [name, value] of Object.entries(attrs)) result = setTagAttr(result, nodeId, name, value);
  return result;
}

/** Make a variant component accept a `ref` and attach it to its root (React 19 — a
 *  plain ref prop, no forwardRef). Needed so a page's layerInView Scroll Variant can
 *  `useInView` the instance's real DOM box. Idempotent + no-op for non-variant files. */
export function ensureComponentAcceptsRef(code: string): string {
  // A design/variant component is identified by a variant root: a `variants={…}`
  // object somewhere, OR the canonical `...style` spread every design-component
  // root carries. (Don't gate on `animate={initialVariant}` — connection-wired
  // components animate a `useState` var, e.g. `animate={variant}`, but still need
  // the ref. Gating ONLY on `variants={` also missed components whose per-variant
  // diffs are all inline ternaries / conditional rendering — e.g. a responsive
  // header whose ROOT has `animate={variant}` but no variants object — so they
  // never got the ref and instance-FX / scroll on them crashed.)
  if (!/\bvariants=\{/.test(code) && !/\.\.\.style\b/.test(code)) return code;
  if (/\bref=\{ref\}/.test(code)) return code;   // already done
  let result = code;
  // 1. Add `ref` to the component function's destructured props. `[^{}]` (no nested
  //    braces) keeps the match inside the destructure even with default values.
  result = result.replace(
    /(function\s+\w+\s*\(\s*\{[^{}]*?)(\})/,
    (m, head, close) => /\bref\b/.test(head) ? m : `${head.replace(/[\s,]+$/, '')}, ref ${close}`,
  );
  // …and its type annotation, when present: `}: { … }` → `; ref?: React.Ref<any> }`.
  // Strip a trailing `;` first so we don't emit `string;; ref?:` (invalid TS).
  result = result.replace(
    /(\}\s*:\s*\{[^{}]*?)(\}\s*\))/,
    (m, typeHead, close) => /\bref\?/.test(typeHead) ? m : `${typeHead.replace(/[\s;]+$/, '')}; ref?: React.Ref<any> ${close}`,
  );
  // 2. Attach `ref={ref}` to the component ROOT — the first motion element whose
  //    opening tag carries the `...style` spread (the instance style-merge target
  //    EVERY design-component root has), inserted right after the tag name. More
  //    robust than "first element with variants={": a component whose ROOT has no
  //    variants object (per-variant size via inline ternaries, children toggled by
  //    conditional rendering) would otherwise get the ref on a nested variants child
  //    — e.g. a hamburger line that only renders in the mobile variant, so in the
  //    default variant `ref.current` is null and motion throws "Target ref is defined
  //    but not hydrated". Fall back to the variants={ element for shapes whose root
  //    carries no spread.
  const rootRe = /<motion\.\w+(?=[^>]*\.\.\.style)/;
  result = rootRe.test(result)
    ? result.replace(rootRe, (m) => `${m} ref={ref}`)
    : result.replace(/<motion\.\w+(?=[^>]*\svariants=\{)/, (m) => `${m} ref={ref}`);
  // Never hand back code that no longer parses — a broken component file makes the
  // canvas render an empty instance shell (parseJSXToNodes swallows the error).
  if (parseJSX(result) === null) {
    trace.error('scrollVariant.ensureRef:parseFailed', { len: code.length });
    return code;
  }
  return result;
}

/** Parse a node's Scroll Variant spec from `data-scroll-variant`, or null. */
export function getScrollVariant(code: string, nodeId: string): ScrollVariantSpec | null {
  return getJsonAttr<ScrollVariantSpec>(code, nodeId, 'data-scroll-variant');
}

/**
 * Clear EVERY reference to a (template/component) variable `varName` from the scroll
 * variants in `code` — the base `fromVar` AND each per-viewport `responsive[scope].fromVar`.
 * `setScrollVariantInCode` then regenerates the effect's `useState`/handler WITHOUT the
 * variable, so DELETING the variable can't leave a dangling identifier (the oracle's
 * "References undefined identifier" crash). No-op when nothing binds `varName`.
 */
export function removeScrollVariantFromVarRefs(code: string, varName: string): string {
  // Find the data-id of every scroll-variant tag whose spec binds `varName`. data-id is
  // emitted on the same opening tag, AFTER data-scroll-variant (generator order).
  const ids: string[] = [];
  const re = /data-scroll-variant='([^']*)'[\s\S]*?data-id="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    let spec: ScrollVariantSpec;
    try { spec = JSON.parse(m[1]) as ScrollVariantSpec; } catch { continue; }
    if (spec.fromVar === varName || (spec.responsive ?? []).some((r) => r.fromVar === varName)) {
      ids.push(m[2]);
    }
  }
  if (!ids.length) return code;
  let out = code;
  for (const id of ids) {
    const spec = getScrollVariant(out, id);
    if (!spec) continue;
    const newSpec: ScrollVariantSpec = { ...spec };
    if (newSpec.fromVar === varName) delete newSpec.fromVar;
    if (newSpec.responsive) {
      newSpec.responsive = newSpec.responsive.map((r) =>
        r.fromVar === varName ? (() => { const { fromVar: _drop, ...rest } = r; return rest; })() : r);
    }
    out = setScrollVariantInCode(out, id, newSpec);
  }
  trace.action('scroll-variant:removed-fromvar-refs', { varName, count: ids.length });
  return out;
}

/** The breakpoint width a `{query}` scope belongs to = its first `max-width` clause
 *  (`(max-width: 768px) and (min-width: 376px)` → 768). Maps a per-viewport
 *  `responsive[scope]` to the matching `data-responsive` breakpoint key. */
function scopeMaxWidth(scope: SerScope | undefined): number | null {
  if (!scope || !('query' in scope) || scope.query === undefined || 'locale' in scope) return null;
  const m = scope.query.match(/max-width:\s*(\d+)px/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * CANVAS-ONLY: bake a per-route template variable into a Scroll Variant's
 * CANVAS display variant — PER VIEWPORT.
 *
 * A Scroll Variant whose RESTING / START variant is bound to a template variable
 * (`spec.fromVar`, set when the var is hoisted) reads that variable at runtime —
 * `useState(headerVariant || (<per-viewport resting>))` — which is JS the canvas
 * Renderer never executes. So for the ACTIVE route we bake the variable's value
 * into the static attributes the parser DOES read, exactly mirroring how
 * deploy/preview resolves `usePathname` → `fromVar` value → resting variant:
 *
 *   PASS 1 — PRIMARY tile: the BASE value (`routeValues[fromVar]`) → the spec's
 *     `canvasVariant`. `expandComponent` reads it (project-parser ~L467) and it
 *     also becomes the node's `componentVariant`, which `resolveVariantStyles`
 *     uses as the primary-tile fallback (the page-primary width is never in the
 *     template-keyed `responsiveVariantMap`).
 *   PASS 2 — REPLICA tiles: each per-viewport override (`routeValues[fromVar@<w>]`)
 *     → the PAIRED `data-responsive` attr's `<w>.initialVariant`. `expandComponent`
 *     lowers `data-responsive` into `responsiveVariantMap[w]` (project-parser
 *     ~L539), so the tablet/mobile tile (whose width matches the template
 *     breakpoint) resolves the page's per-viewport pick. The two attrs are
 *     emitted adjacently by `setScrollVariantInCode`
 *     (`data-scroll-variant='…' initialVariant={…Sv} data-responsive='…'`), so we
 *     pair them by the `[^>]` (same-tag) gap.
 *
 * Runs on the RAW LayoutClient source BEFORE the parser expands the instance —
 * the companion of `substituteTemplateVarAttrsForCanvas` (which only rewrites
 * bare `={var}` attrs and so misses `fromVar` buried inside the spec JSON). The
 * rewritten string is a throwaway parse input (never written to disk), so the
 * source stays byte-identical (source = deploy reality). STRICTLY ADDITIVE: a
 * spec/breakpoint changes ONLY when its `fromVar`(`@<w>`) has a non-empty route
 * value; absent → unchanged (page falls back to the effect's own default).
 * No-op when `routeValues` is empty. `routeValues` is keyed by VARIABLE name — the
 * base `fromVar` (Desktop) AND each per-viewport `responsive[scope].fromVar` (a
 * replica's own variable) — each a plain per-page value.
 */
export function substituteScrollVariantFromVarForCanvas(
  code: string,
  routeValues: Record<string, string>,
): string {
  if (Object.keys(routeValues).length === 0) return code;
  let changed = 0;

  // PASS 1 — primary tile: spec.canvasVariant ← base value.
  let out = code.replace(/data-scroll-variant='([^']*)'/g, (full, json) => {
    let spec: ScrollVariantSpec;
    try { spec = JSON.parse(json) as ScrollVariantSpec; } catch { return full; }
    const fromVar = spec.fromVar;
    if (!fromVar || !(fromVar in routeValues)) return full;
    const val = routeValues[fromVar];
    // Empty route value → page wants the effect's own default; don't override.
    if (!val || spec.canvasVariant === val) return full;
    spec.canvasVariant = val;
    changed++;
    return `data-scroll-variant='${JSON.stringify(spec)}'`;
  });

  // PASS 2 — replica tiles: each per-viewport `responsive[scope].fromVar` (a separate
  // variable bound on Tablet/Mobile) resolves to its variable's per-page value →
  // data-responsive[<w>].initialVariant (the canvas lowers data-responsive into
  // responsiveVariantMap, project-parser ~L539). The scope's max-width picks the
  // breakpoint key. No-op when the spec carries no per-viewport fromVar. `[^>]*?` keeps
  // the data-scroll-variant ↔ data-responsive pair on the SAME opening tag.
  out = out.replace(
    /data-scroll-variant='([^']*)'([^>]*?)data-responsive='([^']*)'/g,
    (full, svJson, between, respJson) => {
      let spec: ScrollVariantSpec;
      let resp: Record<string, any>;
      try { spec = JSON.parse(svJson) as ScrollVariantSpec; } catch { return full; }
      try { resp = JSON.parse(respJson); } catch { return full; }
      const vpEntries = (spec.responsive ?? []).filter((r) => !!r.fromVar);
      if (!vpEntries.length) return full;
      let touched = false;
      for (const r of vpEntries) {
        const w = scopeMaxWidth(r.scope);
        if (w == null) continue;
        const val = routeValues[r.fromVar!];
        if (val == null || val === '') continue; // unset for this route → keep the literal resting
        const key = String(w);
        if (typeof resp[key] !== 'object' || !resp[key]) resp[key] = {};
        if (resp[key].initialVariant === val) continue;
        resp[key].initialVariant = val;
        touched = true;
      }
      if (!touched) return full;
      changed++;
      // svJson is already PASS-1-updated (canvasVariant baked); re-emit verbatim.
      return `data-scroll-variant='${svJson}'${between}data-responsive='${JSON.stringify(resp)}'`;
    },
  );

  if (changed > 0) {
    trace.action('scroll-variant:canvas-fromvar-substituted', { changed, vars: Object.keys(routeValues) });
  }
  return out;
}
