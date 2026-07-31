// component-spec/types.ts — the ComponentBundle contract.
//
// This is the SHAPE the AI must produce (enforced server-side by the matching
// Gemini responseSchema in ai-generator/src/design-spec/schema.ts) and the shape
// the compiler/validator/parser consume. The AI never writes JSX; it produces a
// ComponentBundle, the compiler turns it into .tsx via the EXISTING generators,
// and a resolve-check gates the commit.
//
// Design rule: every field that could express a non-resolving component is either
// absent (unrepresentable) or enum-constrained. Position/transform-string/dead-
// element bugs cannot be typed here.
//
// NOTE on element shape: the wire schema (Gemini) models SpecElement as ONE flat
// object with a `kind` enum + optional fields (structured-output engines handle a
// discriminated union poorly). The TS type below IS a discriminated union for
// ergonomics in compile.ts; validateBundle() is the bridge that confirms the flat
// JSON satisfies the union (kind:'instance' ⇒ component set, kind:'element' ⇒ tag
// set) before compile casts it.

// ─── Leaf style shapes ───────────────────────────────────────────────────────

/** Paint/transform — motion-TWEENABLE. Routed to the variant OBJECT.
 *  Transforms are NUMBERS (rotate/scale/x/y/skew) — a CSS `transform` string is
 *  unrepresentable, so the "animates then reverts" bug can't occur. No
 *  position/layout keys here. */
export interface PaintStyles {
  backgroundColor?: string;
  color?: string;
  opacity?: number;
  borderRadius?: string;
  boxShadow?: string;
  rotate?: number;
  scale?: number;
  x?: number;
  y?: number;
  skewX?: number;
  skewY?: number;
}

/** Layout — must be applied SYNCHRONOUSLY (React, not motion) for FLIP. Routed to
 *  inline-style TERNARIES. Keys are exactly CONDITIONAL_LAYOUT_PROPS. */
export interface LayoutStyles {
  flexDirection?: 'row' | 'column';
  flexWrap?: 'nowrap' | 'wrap';
  justifyContent?: 'flex-start' | 'center' | 'flex-end' | 'space-between' | 'space-around' | 'space-evenly';
  alignItems?: 'flex-start' | 'center' | 'flex-end' | 'stretch' | 'baseline';
  alignContent?: 'flex-start' | 'center' | 'flex-end' | 'stretch' | 'space-between' | 'space-around';
  gap?: string;
  rowGap?: string;
  columnGap?: string;
  gridTemplateColumns?: string;
  gridTemplateRows?: string;
  gridAutoFlow?: 'row' | 'column' | 'dense' | 'row dense' | 'column dense';
  width?: string;
  height?: string;
}

/** The ONLY styles an instance tag may override (WRAPPER_ONLY_STYLE_PROPS). These
 *  ride on the instance tag; everything else lives inside the child component. */
interface WrapperOnlyStyles {
  position?: 'absolute' | 'relative' | 'fixed' | 'sticky';
  left?: string;
  top?: string;
  right?: string;
  bottom?: string;
  transform?: string;
  margin?: string;
  alignSelf?: string;
  order?: number;
}

interface StyleSet {
  paint?: PaintStyles;
  layout?: LayoutStyles;
}

// ─── Variants ────────────────────────────────────────────────────────────────

type VariantKind = 'interactive' | 'responsive' | 'option';

/** A named visual state. No x/y — the compiler tiles variants on the master.
 *  `interaction` marks a hover/pressed state of another variant; the compiler
 *  AUTO-WIRES its connections (the model must not hand-wire hover/pressed). */
export interface SpecVariant {
  name: string;
  label: string;
  kind: VariantKind;
  interaction?: { type: 'hover' | 'pressed'; of: string };
}

// ─── Connections ─────────────────────────────────────────────────────────────

export type ConnectionTrigger = 'click' | 'clickStart' | 'mouseEnter' | 'mouseLeave' | 'inView' | 'afterDelay';

export interface SpecConnection {
  from: string;
  to: string;
  trigger: ConnectionTrigger;
  /** Seconds. inView only — compiler emits the setTimeout chain (×1000). */
  delay?: number;
  /** Element OR instance id where the handler lands; undefined = root.
   *  When this is an instance id, the compiler runs event-prop-forwarding on the child. */
  sourceElement?: string;
}

// ─── Elements (plain node | nested instance) ─────────────────────────────────

type ElementTag =
  | 'div' | 'section' | 'p' | 'h1' | 'h2' | 'h3' | 'span' | 'img' | 'button' | 'a';

export interface VariantOverride {
  variant: string;
  paint?: PaintStyles;
  layout?: LayoutStyles;
  text?: string;
}

interface OrderByVariant {
  variant: string;
  order: number;
}

/** A framer-motion animation state — numbers only (the only animatable kind in
 *  design components). Used as the "from" of an enter animation. */
export interface MotionState {
  opacity?: number;
  x?: number;
  y?: number;
  scale?: number;
  rotate?: number;
  skewX?: number;
  skewY?: number;
}

/** Enter animation: when the element appears / switches into a variant, motion
 *  animates it FROM `from` to its natural state. Compiles to the ternary
 *  `initial={variant === 'X' ? {from} : initialVariant}` + AnimatePresence when the
 *  element is variant-conditional. NEVER a CSS transition — motion only. */
export interface AppearAnimation {
  from: MotionState;
  /** Variants this enter animation plays in. Default: every variant the element
   *  newly appears in (its visibleIn minus the primary). */
  inVariants?: string[];
}

/** Maps a PARENT variant to the inner variant a nested instance shows there. */
interface InnerVariantByParent {
  parent: string;
  child: string;
}

interface SpecElementBase {
  id: string;
  name?: string;
  /** Non-empty → element shows in ≥1 variant. Compiler derives
   *  hiddenVariants = allVariants − visibleIn → AnimatePresence wrap. */
  visibleIn: string[];
  /** Child element ids (tree edges). */
  children?: string[];
}

/** A plain DOM node. */
export interface SpecPlainElement extends SpecElementBase {
  kind: 'element';
  tag: ElementTag;
  text?: string;
  base: StyleSet;
  variantStyles?: VariantOverride[];
  /** Optional reorder-between-variants (CSS order ternary). */
  order?: OrderByVariant[];
  /** Optional motion enter animation (fade/slide/scale in). */
  appear?: AppearAnimation;
}

/** A nested component instance. `component` refs another bundle ComponentSpec.name
 *  (creating/editing it now) OR an existing component from the registry. */
export interface SpecInstanceElement extends SpecElementBase {
  kind: 'instance';
  component: string;
  /** Per-parent-variant inner variant (instance-conditional-prop ternary). */
  innerVariantByParent?: InnerVariantByParent[];
  /** Inner variant when not per-parent (plain initialVariant). */
  defaultInnerVariant?: string;
  /** Only WRAPPER_ONLY_STYLE_PROPS land on the instance tag. */
  styleOverrides?: WrapperOnlyStyles;
}

export type SpecElement = SpecPlainElement | SpecInstanceElement;

// ─── Spec + bundle ───────────────────────────────────────────────────────────

/** One component FILE. */
export interface ComponentSpec {
  /** Stable handle within the bundle; for existing components this is the
   *  registry name, for new ones any unique handle (compiler assigns the real
   *  random PascalCase file/function name). */
  name: string;
  displayName: string;
  /** true → create a new file; false → replace the existing component by name. */
  isNew: boolean;
  variants: SpecVariant[];
  elements: SpecElement[];
  rootId: string;
  connections: SpecConnection[];
}

/** The AI's entire output for one turn. */
export interface ComponentBundle {
  /** The component the user is focused on (must be one of `components[].name`). */
  entry: string;
  components: ComponentSpec[];
}

// ─── Validation result ───────────────────────────────────────────────────────

export interface Violation {
  /** Stable code, e.g. 'DEAD_ELEMENT', 'UNREACHABLE_VARIANT', 'BAD_VARIANT_REF',
   *  'UNKNOWN_COMPONENT', 'RESOLVE_FAILED'. */
  code: string;
  message: string;
  component?: string;
  elementId?: string;
  variant?: string;
}

// ─── Type guards ─────────────────────────────────────────────────────────────

export function isInstanceElement(el: SpecElement): el is SpecInstanceElement {
  return el.kind === 'instance';
}

export function isPlainElement(el: SpecElement): el is SpecPlainElement {
  return el.kind === 'element';
}
