// motion-transform.ts — Translate between framer-motion's INDEPENDENT transform
// props (rotate / scale / x / y / skew …) and a composed CSS `transform` string.
//
// WHY THIS EXISTS
// Inside a design-component (`motion.*`) element, rotation/scale/translate must
// be authored as motion MOTION PROPS (`rotate: 30`) — NOT a CSS `transform`
// string. With `layout={true}`, motion performs its FLIP by writing its own
// CSS `transform`; a raw `transform: 'rotate(30deg)'` lands on the SAME CSS
// property and the two clobber each other (the "animates then reverts" bug).
// The independent props are composed WITH the layout projection, so they
// coexist. (Confirmed: motion.dev/docs/react-motion-component — "independent
// transforms" — and react-layout-animations — layout animates via transform.)
//
// The motion props only work on `motion.*` (live preview = real motion). The
// STATIC canvas Renderer has no motion, so it converts the motion props back to
// a CSS `transform` to display the same result. Single source of truth = the
// motion props in code; this module is the translation layer used by:
//   - Renderer.resolveVariantStyles  (motion props → CSS transform, for canvas)
//   - make-component / variant writers (CSS transform → motion props, on author)

/** Motion transform props motion applies via its own transform system (and
 *  which therefore must NOT be emitted as a raw `transform` string). */
export const MOTION_TRANSFORM_PROPS = new Set<string>([
  'x', 'y', 'z',
  'translateX', 'translateY', 'translateZ',
  'scale', 'scaleX', 'scaleY',
  'rotate', 'rotateX', 'rotateY', 'rotateZ',
  'skewX', 'skewY',
  'transformPerspective',
]);

const PX_DEFAULT = new Set(['x', 'y', 'z', 'translateX', 'translateY', 'translateZ']);
const DEG_DEFAULT = new Set(['rotate', 'rotateX', 'rotateY', 'rotateZ', 'skewX', 'skewY']);

/** Whether a style map carries any motion transform prop. */
export function hasMotionTransformProp(styles: Record<string, unknown>): boolean {
  for (const k of Object.keys(styles)) if (MOTION_TRANSFORM_PROPS.has(k)) return true;
  return false;
}

/** Append the prop's default unit when the value is a bare number (motion
 *  treats `x: 40` as 40px, `rotate: 30` as 30deg). Values that already carry a
 *  unit (`%`, `px`, `deg`, …) or are non-numeric pass through untouched — `x`
 *  legitimately accepts `'40%'`. */
function withUnit(prop: string, raw: unknown): string {
  const v = String(raw).trim();
  if (v === '') return v;
  if (/[a-z%)]$/i.test(v)) return v;            // already unit / keyword / fn
  if (PX_DEFAULT.has(prop)) return `${v}px`;
  if (DEG_DEFAULT.has(prop)) return `${v}deg`;
  return v;                                       // scale* — unitless
}

/**
 * Build a CSS `transform` string from motion transform props, in motion's own
 * composition order (translate → scale → rotate → skew) so the static canvas
 * matches the animated result exactly. Returns '' when no motion transform
 * props are present. Non-transform keys are ignored.
 */
export function motionPropsToCSSTransform(styles: Record<string, unknown>): string {
  // A motion prop bound to a motion MOTION VALUE is stored as the parser's
  // `var:<identifier>` sentinel (e.g. `scale: 'var:cardFxCScale'`) — a DYNAMIC
  // binding, not a static CSS value. Baking it as `scale(var:cardFxCScale)`
  // produces INVALID CSS: the browser rejects the entire `transform` property,
  // which froze the live drag base transform (it captures this string and
  // prepends `translate(dx,dy)`). Skip such props — they can't be represented
  // statically (the live preview's motion drives them; the resting canvas shows
  // none). NOTE: the sentinel is `var:` (colon); CSS `var(--x)` (paren) is left
  // untouched, so a legit custom-property value still passes through.
  const skip = (v: unknown) => typeof v === 'string' && v.trim().startsWith('var:');
  const ok = (v: unknown) => v != null && v !== '' && !skip(v);
  const parts: string[] = [];
  // `transformPerspective` (motion) must come FIRST in the CSS transform.
  if (ok(styles.transformPerspective)) {
    parts.push(`perspective(${withUnit('z', styles.transformPerspective)})`);
  }
  const tx = styles.x ?? styles.translateX;
  const ty = styles.y ?? styles.translateY;
  const tz = styles.z ?? styles.translateZ;
  if (ok(tx)) parts.push(`translateX(${withUnit('x', tx)})`);
  if (ok(ty)) parts.push(`translateY(${withUnit('y', ty)})`);
  if (ok(tz)) parts.push(`translateZ(${withUnit('z', tz)})`);
  if (ok(styles.scale)) parts.push(`scale(${String(styles.scale).trim()})`);
  if (ok(styles.scaleX)) parts.push(`scaleX(${String(styles.scaleX).trim()})`);
  if (ok(styles.scaleY)) parts.push(`scaleY(${String(styles.scaleY).trim()})`);
  if (ok(styles.rotate)) parts.push(`rotate(${withUnit('rotate', styles.rotate)})`);
  if (ok(styles.rotateX)) parts.push(`rotateX(${withUnit('rotateX', styles.rotateX)})`);
  if (ok(styles.rotateY)) parts.push(`rotateY(${withUnit('rotateY', styles.rotateY)})`);
  if (ok(styles.rotateZ)) parts.push(`rotateZ(${withUnit('rotateZ', styles.rotateZ)})`);
  if (ok(styles.skewX)) parts.push(`skewX(${withUnit('skewX', styles.skewX)})`);
  if (ok(styles.skewY)) parts.push(`skewY(${withUnit('skewY', styles.skewY)})`);
  return parts.join(' ');
}

/** Strip a trailing unit so a motion prop holds a bare value (motion re-adds
 *  the default unit). Keeps `%` for translate (`x` accepts `'40%'`). */
function bareValue(prop: string, raw: string): string {
  const v = raw.trim();
  if (v.endsWith('%')) return v;                 // x/y keep percentage
  const m = v.match(/^(-?[\d.]+)\s*(deg|rad|turn|px)?$/i);
  if (!m) return v;
  let n = parseFloat(m[1]);
  const unit = (m[2] || '').toLowerCase();
  if (unit === 'rad') n = n * (180 / Math.PI);
  else if (unit === 'turn') n = n * 360;
  return String(n);
}

/**
 * Parse a CSS `transform` string into motion motion props. Handles the common
 * functions our codegen emits (rotate / scale / skew / translate). Unknown
 * functions (matrix, perspective, …) are skipped. The returned map uses the
 * motion-prop keys (`rotate`, `x`, `y`, `scale`, …) with bare numeric string
 * values, ready to drop into a variant entry.
 *
 *   'rotate(30deg)'            → { rotate: '30' }
 *   'translate(40px, 10px)'    → { x: '40', y: '10' }
 *   'scale(1.2)'               → { scale: '1.2' }
 *   'rotate(15deg) scale(0.5)' → { rotate: '15', scale: '0.5' }
 */
export function cssTransformToMotionProps(transform: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!transform || transform === 'none') return out;
  const fnRe = /([a-zA-Z3]+)\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(transform)) !== null) {
    const fn = m[1];
    const args = m[2].split(',').map((s) => s.trim()).filter((s) => s !== '');
    switch (fn) {
      case 'rotate': case 'rotateZ': out.rotate = bareValue('rotate', args[0] ?? '0'); break;
      case 'rotateX': out.rotateX = bareValue('rotateX', args[0] ?? '0'); break;
      case 'rotateY': out.rotateY = bareValue('rotateY', args[0] ?? '0'); break;
      case 'scale': out.scale = bareValue('scale', args[0] ?? '1'); if (args[1] != null) out.scaleY = bareValue('scaleY', args[1]); break;
      case 'scaleX': out.scaleX = bareValue('scaleX', args[0] ?? '1'); break;
      case 'scaleY': out.scaleY = bareValue('scaleY', args[0] ?? '1'); break;
      case 'translate': case 'translate3d':
        if (args[0] != null) out.x = bareValue('x', args[0]);
        if (args[1] != null) out.y = bareValue('y', args[1]);
        break;
      case 'translateX': out.x = bareValue('x', args[0] ?? '0'); break;
      case 'translateY': out.y = bareValue('y', args[0] ?? '0'); break;
      case 'skewX': out.skewX = bareValue('skewX', args[0] ?? '0'); break;
      case 'skewY': out.skewY = bareValue('skewY', args[0] ?? '0'); break;
      case 'perspective': out.transformPerspective = bareValue('z', args[0] ?? '0'); break;
      // matrix(), perspective(), etc. — not authored by our tools; skip.
    }
  }
  return out;
}

/**
 * The CSS `transform` the STATIC canvas will PAINT for a tile's merged style
 * map (inline base ⊕ `default` entry ⊕ active variant entry) with the rotation
 * overridden — the rotate PREVIEW must produce exactly this, or the gesture
 * jumps. Mirrors Renderer.foldMotionTransforms' composition: a pre-existing
 * CSS `transform` string first (its own rotate() stripped), then the motion
 * shorthands in motion's order. Both a `translate(-50%,-50%)` STRING and
 * `x: '-50%', y: '-50%'` SHORTHANDS survive — the handle's old
 * mergeRotation(getEffectiveStyles().transform) saw only the string form and
 * dropped a shorthand-centred element by half its size for the whole drag
 * (live find 2026-09-05, hamburger bar on the component primary).
 */
export function composeTransformWithRotate(merged: Record<string, unknown>, rotate: number): string {
  const css = typeof merged.transform === 'string' && merged.transform.trim() && merged.transform !== 'none'
    ? merged.transform.replace(/\s*rotate\([^)]*\)/gi, '').trim()
    : '';
  const motion = motionPropsToCSSTransform({ ...merged, rotate });
  return css ? `${css} ${motion}`.trim() : motion;
}

