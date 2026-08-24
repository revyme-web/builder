// master-root-sizing.ts — HUG, or PARENT-SIZED? The one question Make Component
// must answer about the node it is turning into a master root.
//
// A component master is an ARTBOARD: it has no parent layout. Any size the node
// was getting FROM its parent therefore evaporates — a grid cell, a stretched
// flex cross axis, a block box filling its container — and the root falls back
// to hugging its content. That is the grid-child report (2026-08-09: Width read
// `auto` on a card that is 120px wide on the page) and the Fill-row one
// (2026-07-08: master Width 0). `replaceNonPxDimensions` answers both by baking
// the measured px onto the root.
//
// It was baking EVERY axis that carried no key, though, and most of those were
// hugging already. A button that hugs its label got frozen at its measured
// 138px — and the measurement is the ROUNDED border box, so inside a border-box
// with 18px of side padding the label came up a rounding short of its own
// width, wrapped to two lines and spilled out of the pill (reported
// 2026-08-24). Hugging is the one sizing mode that survives the move to an
// artboard untouched: it never needed the parent. The reference tool keeps such
// a root at Fit/Fit for exactly that reason.
//
// So bake the axes the PARENT was sizing and keep the axes the CONTENT was
// sizing. Everything here reads the inline style the node and its parent carry
// in the source — the same place makeComponent reads its other layout decisions
// from, and no canvas round trip.

/** Per-axis verdict. `true` = the CONTENT sizes this axis; leave it alone. */
export interface HugAxes {
  width: boolean;
  height: boolean;
}

/** A style map as read off an element's inline `style={{ … }}` (camelCase keys,
 *  values verbatim). Absent keys are as meaningful as present ones here, so
 *  callers must pass the WHOLE object, not a filtered subset. */
export type StyleMap = Record<string, string>;

/** Actually set? An absent key and an explicit `auto` both mean "not set". */
function isSet(v: string | undefined): boolean {
  const s = (v ?? '').trim();
  return s !== '' && s !== 'auto';
}

/**
 * Does this alignment hand sizing to the parent?
 *
 * `stretch` is the only one that does, and it is the default on both the flex
 * cross axis and a grid track — `normal` behaves as stretch for both, and an
 * absent value falls through to the parent's own default.
 */
function stretches(selfAlign: string | undefined, parentAlign: string | undefined): boolean {
  const own = (selfAlign ?? '').trim();
  const eff = own === '' || own === 'auto' ? (parentAlign ?? '').trim() : own;
  return eff === '' || eff === 'normal' || eff === 'stretch';
}

/** `flex-grow`, from the longhand when present, else the shorthand's first term.
 *  A flex item with no `flex` at all is `0 1 auto` — grow 0. */
function flexGrowOf(style: StyleMap): number {
  const explicit = (style.flexGrow ?? '').trim();
  if (explicit !== '') return parseFloat(explicit) || 0;
  const short = (style.flex ?? '').trim();
  if (short === '' || short === 'none' || short === 'initial') return 0;
  if (short === 'auto') return 1;
  return parseFloat(short) || 0;
}

/** `flex-basis`, same sources. Only `auto`/`content` leave the main size to the
 *  content; a length or percentage basis is a size the parent's line supplied. */
function flexBasisOf(style: StyleMap): string {
  const explicit = (style.flexBasis ?? '').trim();
  if (explicit !== '') return explicit;
  const short = (style.flex ?? '').trim();
  if (short === '' || short === 'none' || short === 'initial' || short === 'auto') return 'auto';
  const parts = short.split(/\s+/);
  // `1 0 0px` → basis is the third term; `1 0` is grow+shrink (basis stays 0%
  // per the shorthand's own default); a lone unitless number is grow.
  if (parts.length >= 3) return parts[2];
  if (parts.length === 2) return /^-?[\d.]+$/.test(parts[1]) ? '0%' : parts[1];
  return /^-?[\d.]+$/.test(parts[0]) ? '0%' : parts[0];
}

/**
 * Which axes of `self` are sized by its own content, given the layout its
 * `parent` establishes. `parent` is null when the node has no element parent in
 * the file (it is that file's root).
 *
 * Reads only what the source states. A style arriving from a `@media` block or
 * a class is invisible here — the inline object is the primary viewport's base,
 * which is the viewport the master is built from.
 */
export function detectHugAxes(self: StyleMap, parent: StyleMap | null): HugAxes {
  const position = (self.position ?? '').trim();
  const display = (self.display ?? '').trim();

  // OUT OF FLOW — the containing block sizes an axis only when BOTH of its
  // edges are pinned. One edge, or none, leaves the box shrink-to-fit.
  if (position === 'absolute' || position === 'fixed') {
    return {
      width: !(isSet(self.left) && isSet(self.right)),
      height: !(isSet(self.top) && isSet(self.bottom)),
    };
  }

  const parentDisplay = (parent?.display ?? '').trim();

  if (parentDisplay === 'flex' || parentDisplay === 'inline-flex') {
    const column = (parent?.flexDirection ?? 'row').trim().startsWith('column');
    const basis = flexBasisOf(self);
    // MAIN axis: a growing item takes the leftover space (Fill). Everything
    // else shrink-wraps, the CSS default `flex: 0 1 auto` included.
    const main = flexGrowOf(self) === 0 && (basis === 'auto' || basis === 'content');
    const cross = !stretches(self.alignSelf, parent?.alignItems);
    return column ? { width: cross, height: main } : { width: main, height: cross };
  }

  if (parentDisplay === 'grid' || parentDisplay === 'inline-grid') {
    // The CELL sizes a grid item on both axes unless the item opts out of
    // stretching — the 2026-08-09 report, where the cell was the only thing
    // that knew the card was 120px.
    return {
      width: !stretches(self.justifySelf, parent?.justifyItems),
      height: !stretches(self.alignSelf, parent?.alignItems),
    };
  }

  // BLOCK FLOW, or no parent element at all.
  return {
    // A block box fills its container's width; an inline-level one shrink-wraps.
    width: /^inline/.test(display) || display === 'table',
    // `height: auto` in block flow IS the content height. The artboard arrives
    // at the same number on its own, so freezing it buys nothing and costs the
    // root its ability to grow with its content.
    height: true,
  };
}
