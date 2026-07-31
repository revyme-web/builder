import { trace } from '@/shared/debug-trace';

// ─── Types ──────────────────────────────────────────────────────────────────

type ComponentControlType =
  | 'slider' | 'color' | 'text' | 'select' | 'toggle' | 'number' | 'upload' | 'slot'
  // `imageList` — an ORDERED list of uploaded images: panel row opens a popup
  //   with a sub-row per image (thumb / reorder / remove) + append-upload.
  //   Value = pipe-separated URLs ('a|b|c'), same convention as multi upload.
  | 'imageList'
  // `font` — a font-family picker. Renders the SAME family control + popup the
  //   Text Style tool uses (FontFamilyControl): a string prop holding the CSS
  //   font-family stack (e.g. "Inter, sans-serif"); the popup loads Google fonts
  //   + injects the @import like a normal text node.
  | 'font'
  // `group` — a button that opens a popup of NESTED controls (each nested
  //   control is a normal flat prop; the group is purely UI organisation).
  // `transition` — a button opening the Motion transition editor; its value
  //   is a JSON-string prop (framer-motion transition object).
  | 'group' | 'transition';

/** Max children a `slot` control accepts: a fixed count or unbounded. */
export type SlotMax = number | 'infinite';

export interface ComponentControlDef {
  type: ComponentControlType;
  label: string;
  /** Default prop value. Absent for `slot` controls (their value is the
   *  connected canvas node(s), expressed as real JSX children). For a
   *  `transition` control the default is the transition OBJECT. */
  default?: string | number | boolean | Record<string, unknown>;
  // number (the reference ControlType.Number). A number with both `min` and `max` DISPLAYS as a slider+input;
  // without a range, or with `displayStepper: true`, it shows a plain number input. (`slider` is a legacy
  // alias that always renders the slider.)
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** Force the plain number input even when min/max are present (the reference's displayStepper). */
  displayStepper?: boolean;
  // select
  options?: { label: string; value: string }[];
  // text
  placeholder?: string;
  // upload
  accept?: string;        // e.g. "image/*", ".glb,.gltf"
  multiple?: boolean;     // true for image sequences
  uploadSource?: string;  // R2 source folder name (e.g. "sequence", "model")
  // slot — how many canvas nodes may be connected into this children prop.
  // `1` for a single slot, a number for a cap, `"infinite"` for unbounded.
  slotMax?: SlotMax;
  // group — the nested controls rendered inside this group's popup. Each is
  // a normal flat prop on the component (the group only nests them in the UI).
  controls?: Record<string, ComponentControlDef>;
  // description shown below the control
  description?: string;
}

export interface ComponentControlsMeta {
  label: string | null;
  comment: string | null;
  controls: Record<string, ComponentControlDef>;
}

// ─── Parser ─────────────────────────────────────────────────────────────────

const LABEL_REGEX = /\/\*\*?\s*@label\s*"([^"]*)"\s*\*\//;
const COMMENT_REGEX = /\/\*\*?\s*@comment\s*"([^"]*)"\s*\*\//;
const CONTROLS_REGEX = /\/\*\*?\s*@controls\s*(\{[\s\S]*?\})\s*\*\//;
// Canvas insert size — `/** @defaultWidth 600 */` + `/** @defaultHeight 400 */`
// (bare numbers = px). Code components are FIXED-size on the canvas: their
// internals are a black box, so an `auto` wrapper collapses whenever the root
// draws via absolute/100% children. These annotations tell every insert path
// (URL paste, library drag) what size to seed the instance at.
const DEFAULT_WIDTH_REGEX = /@defaultWidth\s+(\d+(?:\.\d+)?)/;
const DEFAULT_HEIGHT_REGEX = /@defaultHeight\s+(\d+(?:\.\d+)?)/;

/**
 * Parse @label, @comment, @controls from JSDoc comments in a Code component file.
 * Returns null if no @controls annotation found (i.e., not a Code component).
 */
export function parseComponentControlsMeta(code: string): ComponentControlsMeta | null {
  const controlsMatch = code.match(CONTROLS_REGEX);
  if (!controlsMatch) return null;

  let controls: Record<string, ComponentControlDef> = {};
  try {
    controls = JSON.parse(controlsMatch[1]);
  } catch {
    trace.error('controls-parser:parse-failed', { raw: controlsMatch[1].slice(0, 100) });
    return null;
  }

  const labelMatch = code.match(LABEL_REGEX);
  const commentMatch = code.match(COMMENT_REGEX);

  trace.fn('controls-parser:parse', {
    label: labelMatch?.[1] || null,
    controlCount: Object.keys(controls).length,
  });

  return {
    label: labelMatch ? labelMatch[1] : null,
    comment: commentMatch ? commentMatch[1] : null,
    controls,
  };
}

/**
 * Check if a file contains @controls metadata (quick check without full parse).
 */
export function hasComponentControls(code: string): boolean {
  return CONTROLS_REGEX.test(code);
}

export interface CodeComponentDefaultSize {
  width: number | null;
  height: number | null;
}

/**
 * Parse the `@defaultWidth` / `@defaultHeight` canvas-insert-size annotations
 * from a code component's source. Null per axis when not declared — callers
 * fall back to the master root's authored size, then to the shared
 * 200×200 default.
 */
export function parseCodeComponentDefaultSize(code: string): CodeComponentDefaultSize {
  const w = code.match(DEFAULT_WIDTH_REGEX);
  const h = code.match(DEFAULT_HEIGHT_REGEX);
  const out = {
    width: w ? parseFloat(w[1]) : null,
    height: h ? parseFloat(h[1]) : null,
  };
  trace.fn('controls-parser:default-size', out);
  return out;
}
