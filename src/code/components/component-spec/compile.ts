// component-spec/compile.ts — turn a ComponentBundle into .tsx files.
//
// The compiler is the ONLY thing that writes JSX. It direct-emits the
// deterministic parts (file skeleton, motion JSX tree, variant-object consts,
// layout ternaries) using the verified formats, and REUSES the real emitters for
// the hairy parts: `setVariantVisibilityInCode` (AnimatePresence) and
// `generateConnectionCode` (useState + gated handlers + animate). Nested
// instances emit a tag + import; "make a component from a subtree" needs no
// special code — it's just two specs in the bundle, each compiled to its file.
//
// Output is gated by validate (before) and resolveCheck (after) — see the loop.

import { trace } from '@/shared/debug-trace';
import { CONDITIONAL_LAYOUT_PROPS, CSS_LAYOUT_DEFAULTS } from '@/shared/constants';
import { serializeVariantConfig, type VariantConfig } from '@/code/variants/variant-config';
import {
  serializeConnections,
  replaceConnectionsInCode,
  generateConnectionCode,
  type Connection,
} from '@/code/variants/connection-config';
import { setVariantVisibilityInCode } from '@/code/generation/variant-visibility-gen';
import { formatConditionalPropExpression } from '@/code/components/instance-conditional-prop';
import { generateInternalName } from '@/code/components/component-ops';
import type {
  ComponentBundle,
  ComponentSpec,
  SpecElement,
  PaintStyles,
  LayoutStyles,
} from './types';
import { isInstanceElement, isPlainElement } from './types';

/** Motion transforms stored as bare numbers in variant objects, with a neutral
 *  the `default` entry must carry so motion can animate back. */
const MOTION_NEUTRAL: Record<string, number> = {
  rotate: 0, scale: 1, x: 0, y: 0, skewX: 0, skewY: 0,
};
const NUMERIC_PAINT = new Set(['opacity', ...Object.keys(MOTION_NEUTRAL)]);

/** Style keys the compiler NEVER emits. `display` → visibility is `visibleIn`
 *  (AnimatePresence), never a toggle. `transform` → use motion props (rotate/x/y…).
 *  `transition`/`animation` → use motion motion (MotionConfig / appear), never CSS.
 *  Everything else (backgroundImage, border, cursor, fontSize, left/top on children…)
 *  passes through normally. */
const FORBIDDEN_STYLE = new Set([
  'display', 'transform',
  'transition', 'transitionProperty', 'transitionDuration', 'transitionDelay', 'transitionTimingFunction',
  'animation', 'animationName', 'animationDuration', 'animationTimingFunction', 'animationDelay',
  'willChange',
]);

/** A paint key = not forbidden and not a (ternary-routed) layout prop. */
function isPaintKey(k: string): boolean {
  return !FORBIDDEN_STYLE.has(k) && !CONDITIONAL_LAYOUT_PROPS.has(k);
}

type PlainEl = Extract<SpecElement, { kind: 'element' }>;

/** Layout keys whose presence makes an element a flex/grid container even when it
 *  has no children yet (an empty frame the user will drop things into). */
const FLEX_HINT_KEYS = ['flexDirection', 'flexWrap', 'justifyContent', 'alignItems', 'alignContent', 'gap', 'rowGap', 'columnGap'];
const GRID_HINT_KEYS = ['gridTemplateColumns', 'gridTemplateRows', 'gridAutoFlow'];

/** The schema has no `display` on purpose (visibility is visibleIn) — so the
 *  COMPILER owns it. Anything with children or flow props must get an explicit
 *  `display:'flex'|'grid'`, matching what the canvas creators emit; without it the
 *  model's flexDirection/gap/justifyContent are dead and the whole layout
 *  collapses into a block stack. */
function containerKind(el: PlainEl): 'flex' | 'grid' | null {
  const layouts = [el.base?.layout ?? {}, ...(el.variantStyles ?? []).map((o) => o.layout ?? {})] as Record<string, unknown>[];
  if (layouts.some((l) => GRID_HINT_KEYS.some((k) => l[k] != null))) return 'grid';
  if ((el.children?.length ?? 0) > 0 || layouts.some((l) => FLEX_HINT_KEYS.some((k) => l[k] != null))) return 'flex';
  return null;
}

/** Default smooth transition — emitted as <MotionConfig> so variant changes spring
 *  instead of snapping. This is what makes tabs slide and panes ease in/out. */
const SPRING_TRANSITION = "{ type: 'spring', stiffness: 300, damping: 30, mass: 1 }";

export interface CompiledFile {
  /** Bundle-local spec name. */
  specName: string;
  /** Real file path, e.g. components/BaCeDa.tsx */
  filePath: string;
  /** Real function/import name (random internal name for new components). */
  internalName: string;
  code: string;
  isNew: boolean;
}

export interface CompileOptions {
  /** Resolve a spec/component name → its real internal (file) name. Used so an
   *  instance referencing another component imports the right symbol. Existing
   *  components map name→name; new ones get a fresh random name. Defaults handle
   *  the common case. */
  nameFor?: (name: string) => string;
}

/** Compile a whole bundle. Assigns internal names first (so cross-references
 *  resolve), then compiles each spec. */
export function compileBundle(bundle: ComponentBundle, opts: CompileOptions = {}): CompiledFile[] {
  trace.fn('component-spec.compileBundle', { entry: bundle.entry, count: bundle.components.length });

  const nameMap = new Map<string, string>();
  for (const spec of bundle.components) {
    nameMap.set(spec.name, spec.isNew ? generateInternalName() : spec.name);
  }
  const nameFor = (n: string) => opts.nameFor?.(n) ?? nameMap.get(n) ?? n;

  return bundle.components.map((spec) => {
    const internalName = nameMap.get(spec.name)!;
    const code = compileComponentSpec(spec, { nameFor, internalName });
    return { specName: spec.name, filePath: `components/${internalName}.tsx`, internalName, code, isNew: spec.isNew };
  });
}

/** Compile one component spec → full .tsx code. */
export function compileComponentSpec(
  rawSpec: ComponentSpec,
  ctx: { nameFor: (name: string) => string; internalName?: string },
): string {
  const internalName = ctx.internalName ?? ctx.nameFor(rawSpec.name);
  trace.fn('component-spec.compileComponentSpec', { name: rawSpec.name, internalName, variants: rawSpec.variants.length });

  // 0. canonicalize the model's styles (drop no-op deltas, promote shared values
  //    to base) so junk in the spec can't become junk in the file.
  const spec = normalizeSpec(rawSpec);

  const variantNames = spec.variants.map((v) => v.name);
  const byId = new Map(spec.elements.map((e) => [e.id, e]));

  // 1. variantConfig (compiler owns x/y; maps interaction → metadata)
  const variantConfig = buildVariantConfig(spec, internalName);

  // 2. JSX tree + collected variant-object consts (no visibility/connections yet)
  const consts: string[] = [];
  const imports = new Set<string>();
  const jsx = emitElement(spec.rootId, byId, variantNames, consts, imports, ctx.nameFor, /*isRoot*/ true);

  // 3. assemble the file skeleton
  let code = assembleFile({ internalName, displayName: spec.displayName, variantConfig, consts, imports, jsx });

  // 4. connections (explicit + auto-wired hover/pressed) — reuse the real emitter.
  //    Runs BEFORE visibility so the useState scaffolding exists when wrappers are
  //    emitted: the visibility emitter then writes `variant !== 'x'` conditions
  //    directly, instead of `initialVariant !== 'x'` that a fragile post-hoc
  //    migration (regex over nested AnimatePresence blocks) had to rewrite.
  const connections = buildConnections(spec);
  if (connections.length > 0) {
    code = replaceConnectionsInCode(code, serializeConnections(connections));
    code = generateConnectionCode(code, connections);
  }

  // 5. visibility — reuse the real emitter (→ AnimatePresence), but ONLY where an
  //    element actually needs its own wrapper. Visibility INHERITS from ancestors:
  //    if a parent is already hidden in variants {a,b}, its children don't need
  //    their own AnimatePresence for {a,b} — the parent's wrapper removes the whole
  //    subtree. An element only needs a wrapper for variants where IT hides but its
  //    PARENT is still visible. Without this, every leaf gets wrapped → popLayout
  //    yanks them out of flow → the layout collapses.
  const wrapOps = computeVisibilityWraps(spec, byId, variantNames);
  // Apply deepest-first so wrapping a parent doesn't disturb finding its children.
  for (let i = wrapOps.length - 1; i >= 0; i--) {
    const { id, hidden } = wrapOps[i];
    code = setVariantVisibilityInCode(code, id, hidden, variantNames);
  }

  return code;
}

/** Canonicalize the model's styles BEFORE emission. The model loves repeating
 *  unchanged values into every variant delta (`border:'none'` × N variants) —
 *  emitted faithfully that becomes junk variant objects and degenerate layout
 *  ternaries whose else-branch erases the value. Two behavior-preserving rewrites
 *  per style bucket:
 *    1. a delta entry equal to the base value is dropped;
 *    2. a key set to the SAME value in EVERY variant's delta (and absent from
 *       base) is promoted to base.
 *  Deltas left empty are removed entirely. Pure — returns a clone. */
/** Position keys the ROOT element may never carry — master artboard placement
 *  belongs to the canvas (variantConfig x/y + absolute positioning). A root
 *  `position:'relative'` inside a motion variants object would re-anchor the
 *  artboard into document flow and pile the variants on top of each other. */
const ROOT_FORBIDDEN_PAINT = ['position', 'left', 'top', 'right', 'bottom'];

function normalizeSpec(spec: ComponentSpec): ComponentSpec {
  const out = structuredClone(spec);
  const allVariants = out.variants.map((v) => v.name);
  let dropped = 0;
  let promoted = 0;
  for (const el of out.elements) {
    if (!isPlainElement(el)) continue;
    if (!el.base) el.base = {};
    {
      const buckets = [el.base.paint, ...(el.variantStyles ?? []).map((o) => o.paint)]
        .filter(Boolean) as Record<string, unknown>[];
      if (el.id === out.rootId) {
        // Root may never carry position/offsets — canvas owns artboard placement.
        for (const b of buckets) {
          for (const k of ROOT_FORBIDDEN_PAINT) {
            if (k in b) { delete b[k]; dropped++; }
          }
        }
      } else {
        // Offsets without a position anywhere on the element are CSS-inert —
        // strip them instead of bouncing (renders identically, saves a retry).
        const hasPosition = buckets.some((b) => typeof b.position === 'string' && b.position !== 'static');
        if (!hasPosition) {
          for (const b of buckets) {
            for (const k of ['left', 'top', 'right', 'bottom']) {
              if (k in b) { delete b[k]; dropped++; }
            }
          }
        }
      }
    }
    for (const bucket of ['paint', 'layout'] as const) {
      const base = ((el.base as Record<string, unknown>)[bucket] ?? {}) as Record<string, unknown>;
      const deltaFor = new Map<string, Record<string, unknown>>();
      for (const ov of el.variantStyles ?? []) {
        if (ov[bucket]) deltaFor.set(ov.variant, ov[bucket] as Record<string, unknown>);
      }
      // 1. delta entry equal to base → redundant, drop
      for (const d of deltaFor.values()) {
        for (const k of Object.keys(d)) {
          if (d[k] === base[k]) { delete d[k]; dropped++; }
        }
      }
      // 2. same value in EVERY variant's delta + nothing in base → it IS the base value
      if (allVariants.length > 0 && allVariants.every((v) => deltaFor.has(v))) {
        const [first, ...rest] = allVariants.map((v) => deltaFor.get(v)!);
        for (const k of Object.keys(first)) {
          if (base[k] !== undefined) continue; // base survived rewrite 1 → it genuinely differs
          const val = first[k];
          if (rest.every((d) => d[k] === val)) {
            base[k] = val;
            for (const d of deltaFor.values()) delete d[k];
            promoted++;
          }
        }
      }
      if (Object.keys(base).length > 0) (el.base as Record<string, unknown>)[bucket] = base;
    }
    // drop deltas that no longer carry anything
    const kept = (el.variantStyles ?? []).filter(
      (ov) => Object.keys(ov.paint ?? {}).length > 0 || Object.keys(ov.layout ?? {}).length > 0 || ov.text != null,
    );
    if (kept.length > 0) el.variantStyles = kept;
    else delete el.variantStyles;
  }
  if (dropped || promoted) trace.action('component-spec:normalize', { name: spec.name, dropped, promoted });
  return out;
}

// ─── variantConfig ───────────────────────────────────────────────────────────

function buildVariantConfig(spec: ComponentSpec, _internalName: string): VariantConfig[] {
  return spec.variants.map((v, i): VariantConfig => {
    const out: VariantConfig = { name: v.name, label: v.label, x: i * 600, y: 0 };
    if (i === 0) out.isPrimary = true;
    if (v.interaction) {
      out.interactionType = v.interaction.type === 'pressed' ? 'pressed' : 'hover';
      out.parentVariant = v.interaction.of;
    }
    return out;
  });
}

// ─── connections (explicit + auto-wired interaction states) ──────────────────

function buildConnections(spec: ComponentSpec): Connection[] {
  const out: Connection[] = spec.connections.map((c) => {
    const conn: Connection = { from: c.from, to: c.to, trigger: c.trigger };
    if (c.delay != null) conn.delay = c.delay;
    if (c.sourceElement) conn.sourceNode = c.sourceElement;
    return conn;
  });

  // Auto-wire hover/pressed (the model never hand-writes these — validate enforces).
  for (const v of spec.variants) {
    if (!v.interaction) continue;
    const src = v.interaction.of;
    if (v.interaction.type === 'hover') {
      out.push({ from: src, to: v.name, trigger: 'mouseEnter' });
      out.push({ from: v.name, to: src, trigger: 'mouseLeave' });
    } else {
      out.push({ from: src, to: v.name, trigger: 'clickStart' });
      out.push({ from: v.name, to: src, trigger: 'click' });
    }
  }
  return out;
}

// ─── JSX emission ────────────────────────────────────────────────────────────

function emitElement(
  id: string,
  byId: Map<string, SpecElement>,
  variantNames: string[],
  consts: string[],
  imports: Set<string>,
  nameFor: (n: string) => string,
  isRoot: boolean,
  parentKind: 'flex' | 'grid' | null = null,
): string {
  const el = byId.get(id);
  if (!el) return '';

  // Nested component instance → tag + import.
  if (isInstanceElement(el)) {
    const comp = nameFor(el.component);
    imports.add(comp);
    const attrs = [`data-id="${el.id}"`, `data-name="${esc(el.name ?? comp)}"`];
    if (el.innerVariantByParent && el.innerVariantByParent.length > 0) {
      const map: Record<string, string> = { default: el.defaultInnerVariant ?? 'default' };
      for (const { parent, child } of el.innerVariantByParent) map[parent] = child;
      attrs.push(`initialVariant={${formatConditionalPropExpression(map, 'initialVariant')}}`);
    } else if (el.defaultInnerVariant) {
      attrs.push(`initialVariant="${el.defaultInnerVariant}"`);
    }
    const wrapper = el.styleOverrides ? emitWrapperStyle(el.styleOverrides as Record<string, unknown>) : '';
    if (wrapper) attrs.push(wrapper);
    return `<${comp} ${attrs.join(' ')} />`;
  }

  // Plain element → motion.<tag>.
  const tag = `motion.${el.tag}`;
  const attrs: string[] = [`data-id="${el.id}"`, `data-name="${esc(el.name ?? el.tag)}"`, 'layout'];

  // variant object (only when paint varies across variants); else paint goes inline.
  const variantObj = buildVariantObject(el, variantNames);
  if (variantObj) {
    const constName = `${camel(el.id)}Variants`;
    consts.push(`const ${constName} = ${variantObj};`);
    attrs.push(`variants={${constName}}`);
  }

  // enter animation → initial ternary (connection codegen migrates initialVariant→variant).
  // Default inVariants = the variants the element APPEARS in minus the primary
  // (per AppearAnimation docs) — not every non-primary variant; a drawer visible
  // only in 'open' shouldn't carry enter branches for states it never mounts in.
  if (el.appear) {
    const visible = new Set(el.visibleIn ?? variantNames);
    const inV = el.appear.inVariants?.length
      ? el.appear.inVariants
      : variantNames.slice(1).filter((n) => visible.has(n));
    if (inV.length) attrs.push(`initial={${buildEnterInitial(el.appear.from, inV)}}`);
  }

  // inline style = canvas defaults (display/position/flex) + static paint (when no
  // variant object) + layout (plain or ternary) + root spread.
  const kind = containerKind(el);
  const style = buildInlineStyle(el, variantNames, /*paintInline*/ !variantObj, isRoot, kind, parentKind);
  if (style) attrs.push(`style={${style}}`);

  const children = (el.children ?? []).map((cid) => emitElement(cid, byId, variantNames, consts, imports, nameFor, false, kind)).join('\n');
  const text = el.text ? esc(el.text) : '';
  const inner = children || text;
  return inner
    ? `<${tag} ${attrs.join(' ')}>${inner}</${tag}>`
    : `<${tag} ${attrs.join(' ')} />`;
}

/** Build `{ default: {...}, 'v': {...} }` for paint, or null if paint never varies. */
function buildVariantObject(el: Extract<SpecElement, { kind: 'element' }>, variantNames: string[]): string | null {
  if (!el.variantStyles || el.variantStyles.length === 0) return null;
  const deltas = new Map(el.variantStyles.map((o) => [o.variant, o.paint ?? {}]));
  // any KNOWN paint key touched anywhere (display/position/transform dropped —
  // visibility goes through visibleIn, not a style)
  const keys = new Set<string>();
  for (const k of Object.keys(el.base.paint ?? {})) if (isPaintKey(k)) keys.add(k);
  for (const o of deltas.values()) for (const k of Object.keys(o)) if (isPaintKey(k)) keys.add(k);
  if (keys.size === 0) return null;

  const entry = (paint: PaintStyles): string => {
    const parts: string[] = [];
    for (const k of keys) {
      const val = (paint as Record<string, unknown>)[k];
      if (val === undefined) {
        // default entry must carry neutral for animated transforms it doesn't set
        if (k in MOTION_NEUTRAL) parts.push(`${k}: ${MOTION_NEUTRAL[k]}`);
        continue;
      }
      parts.push(emitPaint(k, val));
    }
    return `{ ${parts.join(', ')} }`;
  };

  // EVERY variant gets an entry (base merged with its delta, or plain base).
  // framer-motion has NO fallback for a missing variant key: `animate="desktop"`
  // against an object without a 'desktop' entry applies NOTHING — the element
  // loses its paint on that artboard, and a toggled state can never animate
  // BACK to a variant that has no entry (hamburger stuck as an X).
  const lines: string[] = [`default: ${entry(el.base.paint ?? {})}`];
  for (const name of variantNames) {
    if (name === 'default') continue;
    const merged: PaintStyles = { ...(el.base.paint ?? {}), ...(deltas.get(name) ?? {}) };
    lines.push(`'${name}': ${entry(merged)}`);
  }
  return `{\n  ${lines.join(',\n  ')},\n}`;
}

/** Inline style object string: canvas defaults + static paint (optional) +
 *  layout (plain/ternary) + root `...style`. */
function buildInlineStyle(
  el: PlainEl,
  variantNames: string[],
  paintInline: boolean,
  isRoot: boolean,
  kind: 'flex' | 'grid' | null,
  parentKind: 'flex' | 'grid' | null,
): string | null {
  const parts: string[] = [];
  const paint = (el.base.paint ?? {}) as Record<string, unknown>;
  const pos = paint.position as string | undefined;

  // Canvas conventions the schema doesn't expose — same defaults the creators
  // emit (FrameCreator/LayoutCreator), so compiled elements behave like
  // hand-built ones for layout, drag and resize:
  //   display  — compiler-owned (schema has no display); containers get flex/grid.
  //   position — children default to 'relative' so absolute grandchildren anchor.
  //   flex     — '0 0 auto' so flex children keep their size instead of squashing.
  if (kind) parts.push(`display: '${kind}'`);
  if (!isRoot && pos === undefined) parts.push(`position: 'relative'`);
  if (!isRoot && parentKind === 'flex' && pos !== 'absolute' && pos !== 'fixed' && paint.flex === undefined) {
    parts.push(`flex: '0 0 auto'`);
  }

  if (paintInline) {
    for (const [k, v] of Object.entries(el.base.paint ?? {})) if (isPaintKey(k)) parts.push(emitPaint(k, v));
  }

  // layout — base value, overridden per-variant via ternary when it differs
  const layoutDeltas = new Map<string, Map<string, string | number>>(); // prop -> variant -> value
  for (const ov of el.variantStyles ?? []) {
    for (const [k, v] of Object.entries(ov.layout ?? {})) {
      if (!CONDITIONAL_LAYOUT_PROPS.has(k)) continue;
      if (!layoutDeltas.has(k)) layoutDeltas.set(k, new Map());
      layoutDeltas.get(k)!.set(ov.variant, v as string | number);
    }
  }
  const baseLayout = el.base.layout ?? ({} as LayoutStyles);
  const layoutKeys = new Set<string>([...Object.keys(baseLayout), ...layoutDeltas.keys()].filter((k) => CONDITIONAL_LAYOUT_PROPS.has(k)));
  for (const k of layoutKeys) {
    const baseVal = (baseLayout as Record<string, unknown>)[k];
    const deltas = layoutDeltas.get(k);
    if (!deltas || deltas.size === 0) {
      if (baseVal !== undefined) parts.push(`${k}: ${quote(baseVal)}`);
      continue;
    }
    // ternary keyed on the live variant when connection state exists (emitted
    // after connections — see compileComponentSpec step order), else initialVariant
    const chain = variantNames
      .filter((n) => deltas.has(n))
      .map((n) => `initialVariant === '${n}' ? ${quote(deltas.get(n)!)}`)
      .join(' : ');
    // else-branch: base value, or the CSS initial value — never '' (empty string
    // means "remove property" downstream, silently erasing the value for any
    // variant the chain doesn't list).
    const elseVal = baseVal !== undefined ? quote(baseVal) : quote(CSS_LAYOUT_DEFAULTS[k] ?? '');
    parts.push(`${k}: ${chain} : ${elseVal}`);
  }

  // order ternary (reorder between variants)
  if (el.order && el.order.length > 0) {
    const m = new Map(el.order.map((o) => [o.variant, o.order]));
    const chain = variantNames.filter((n) => m.has(n)).map((n) => `initialVariant === '${n}' ? ${m.get(n)}`).join(' : ');
    parts.push(`order: ${chain} : 0`);
  }

  if (isRoot) parts.push('...style');
  if (parts.length === 0) return null;
  // returns the object literal `{ … }`; caller wraps as style={ … } → style={{ … }}
  return `{ ${parts.join(', ')} }`;
}

/** Walk the tree from root; for each element return the variants it needs its OWN
 *  AnimatePresence for = (variants it hides in) − (variants its parent already hides
 *  in). Empty → no wrapper. Returned in pre-order (parent before child), so applying
 *  in reverse wraps deepest-first. This is what stops every leaf from getting its
 *  own wrapper when its parent already hides the whole subtree. */
function computeVisibilityWraps(
  spec: ComponentSpec,
  byId: Map<string, SpecElement>,
  variantNames: string[],
): { id: string; hidden: string[] }[] {
  const ownHidden = new Map<string, Set<string>>();
  for (const el of spec.elements) ownHidden.set(el.id, new Set(hiddenVariantsFor(el, variantNames)));

  const out: { id: string; hidden: string[] }[] = [];
  const seen = new Set<string>();
  const walk = (id: string, parentEffective: Set<string>): void => {
    if (seen.has(id)) return; // guard against malformed cycles
    seen.add(id);
    const own = ownHidden.get(id) ?? new Set<string>();
    // this element's OWN wrapper only covers variants the parent doesn't already hide
    const wrap = [...own].filter((v) => !parentEffective.has(v));
    if (wrap.length) out.push({ id, hidden: wrap });
    // effective hidden cascades to children
    const effective = new Set<string>([...own, ...parentEffective]);
    const el = byId.get(id);
    const children = el && isPlainElement(el) ? el.children ?? [] : [];
    for (const cid of children) walk(cid, effective);
  };
  walk(spec.rootId, new Set());
  return out;
}

/** Variants where this element should NOT render. = variants not in visibleIn,
 *  plus any variant whose effective `display` (base overridden by the variant
 *  delta) is 'none'. Folding display here means a model that hides via
 *  `display:'none'` still gets a clean AnimatePresence mount/unmount. */
function hiddenVariantsFor(el: SpecElement, variantNames: string[]): string[] {
  const visible = new Set(el.visibleIn ?? variantNames);
  const baseDisplay = readDisplay(isInstanceElement(el) ? undefined : el.base);
  const perVariant = new Map<string, string | undefined>();
  if (!isInstanceElement(el)) {
    for (const ov of el.variantStyles ?? []) perVariant.set(ov.variant, readDisplay(ov));
  }
  const hidden: string[] = [];
  for (const v of variantNames) {
    const disp = perVariant.has(v) ? perVariant.get(v) : baseDisplay;
    if (!visible.has(v) || disp === 'none') hidden.push(v);
  }
  return hidden;
}

/** display can arrive in either bucket (or off-schema) — read it from any. */
function readDisplay(s: { paint?: unknown; layout?: unknown } | undefined): string | undefined {
  if (!s) return undefined;
  const p = (s.paint ?? {}) as Record<string, unknown>;
  const l = (s.layout ?? {}) as Record<string, unknown>;
  const d = (p.display ?? l.display) as string | undefined;
  return d;
}

/** `initialVariant === 'v1' ? { opacity: 0, y: 30 } : initialVariant` — the enter
 *  ternary. The `initialVariant ===` conditions are migrated to `variant ===` by
 *  the connection codegen when the component has state. */
function buildEnterInitial(from: import('./types').MotionState, variants: string[]): string {
  const state = emitMotionState(from);
  const chain = variants.map((v) => `initialVariant === '${v}' ? ${state}`).join(' : ');
  return `${chain} : initialVariant`;
}

/** `{ opacity: 0, y: 30 }` — motion props are bare numbers. */
function emitMotionState(s: import('./types').MotionState): string {
  const parts = Object.entries(s)
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => `${k}: ${v}`);
  return `{ ${parts.join(', ')} }`;
}

function emitWrapperStyle(s: Record<string, unknown>): string {
  const parts = Object.entries(s).map(([k, v]) => `${k}: ${quote(v as string | number)}`);
  return parts.length ? `style={{ ${parts.join(', ')} }}` : '';
}

// ─── file skeleton ───────────────────────────────────────────────────────────

function assembleFile(a: {
  internalName: string;
  displayName: string;
  variantConfig: VariantConfig[];
  consts: string[];
  imports: Set<string>;
  jsx: string;
}): string {
  const componentImports = [...a.imports]
    .map((c) => `import ${c} from '@/components/${c}';`)
    .join('\n');
  const constsBlock = a.consts.length > 0 ? `\n${a.consts.join('\n')}\n` : '';
  return `import React from 'react';
import { motion, LayoutGroup, MotionConfig, AnimatePresence } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
${componentImports ? componentImports + '\n' : ''}
/** @name "${esc(a.displayName)}" */

${serializeVariantConfig(a.variantConfig)}
${constsBlock}
function ${a.internalName}({ style, initialVariant = 'default' }: { style?: React.CSSProperties; initialVariant?: string }) {
  return (
    <LayoutGroup>
    <MotionConfig transition={${SPRING_TRANSITION}}>
    ${a.jsx}
    </MotionConfig>
    </LayoutGroup>
  );
}

export default withResponsiveProps(${a.internalName});
`;
}

// ─── value emission ──────────────────────────────────────────────────────────

/** Paint prop: motion transforms + opacity are bare numbers; everything else quoted. */
function emitPaint(k: string, v: unknown): string {
  if (NUMERIC_PAINT.has(k) && typeof v === 'number') return `${k}: ${v}`;
  return `${k}: ${quote(v as string | number)}`;
}

function quote(v: unknown): string {
  return typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "\\'")}'`;
}

function esc(s: string): string {
  return s.replace(/"/g, '&quot;');
}

function camel(id: string): string {
  return id.replace(/[-_]([a-zA-Z0-9])/g, (_, c) => c.toUpperCase()).replace(/[^a-zA-Z0-9]/g, '');
}
