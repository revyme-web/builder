// event-prop-forwarding.ts — Forward parent event handlers to a component root.
//
// A connection placed on a NESTED component instance (e.g. an open/close button
// dropped into a parent component) needs the parent's `onTap` / `onHoverStart` /
// etc. to actually reach a `motion.*` element so framer-motion fires it. A plain
// component instance (`<JiPoZa onTap={...} />`) swallows those props — `JiPoZa`
// never spreads them onto its root, so the click does nothing.
//
// The fix: make the component forward unknown props (`...rest`) onto its root
// motion element. The parent writes `onTap` on the instance tag (see
// connection-config), `...rest` carries it through, and the component's root
// motion.div fires the variant transition — using the PARENT's `setVariant`
// closure (the handler is authored in the parent).
//
// `data-id` / `data-name` are destructured OUT of `...rest` so the instance's
// ids never clobber the component root's own ids (which the parser/expander
// rely on). `{...rest}` is spread FIRST on the root so any handler the root
// declares itself still wins over a forwarded one.

import { trace } from '@/shared/debug-trace';

/** Does this component file already forward `...rest` to its root? */
export function forwardsEventProps(code: string): boolean {
  return /\.\.\.rest\b/.test(code);
}

/**
 * Make a component file forward parent event props to its root motion element.
 * Idempotent — a file that already forwards is returned unchanged. Returns the
 * input unchanged when the signature isn't a recognizable component shape.
 */
export function forwardEventPropsToComponentRoot(code: string): string {
  if (forwardsEventProps(code)) return code;

  const newParams = ", 'data-id': _dataId, 'data-name': _dataName, ...rest ";

  // 1. Function signature. Add data-id/data-name exclusion + `...rest`, and —
  //    when there's a type annotation — loosen it so the forwarded keys
  //    type-check. Handle both shapes:
  //      function NAME({ <params> }: { <type> }) {   (generated — typed)
  //      function NAME({ <params> }) {                (hand-edited — untyped)
  let out: string;
  const typedRe = /(function\s+\w+\s*\(\s*\{)([^}]*?)(\}\s*:\s*\{)([^}]*?)(\}\s*\))/;
  const typedM = typedRe.exec(code);
  if (typedM) {
    const params = typedM[2].replace(/\s+$/, '').replace(/,\s*$/, '');
    const typeBody = typedM[4].replace(/\s+$/, '').replace(/;\s*$/, '');
    out =
      code.slice(0, typedM.index) +
      `${typedM[1]}${params}${newParams}${typedM[3]}${typeBody}; [key: string]: unknown ${typedM[5]}` +
      code.slice(typedM.index + typedM[0].length);
  } else {
    const untypedRe = /(function\s+\w+\s*\(\s*\{)([^}]*?)(\}\s*\))/;
    const untypedM = untypedRe.exec(code);
    if (!untypedM) {
      trace.fn('event-prop-forwarding:no-signature', {});
      return code;
    }
    const params = untypedM[2].replace(/\s+$/, '').replace(/,\s*$/, '');
    out =
      code.slice(0, untypedM.index) +
      `${untypedM[1]}${params}${newParams}${untypedM[3]}` +
      code.slice(untypedM.index + untypedM[0].length);
  }

  // 2. Spread `{...rest}` onto the FIRST motion element (the variant root).
  //    Placed first so the root's own explicit props override forwarded ones.
  if (!/<motion\.\w+/.test(out)) {
    trace.fn('event-prop-forwarding:no-root-motion', {});
    return code;
  }
  out = out.replace(/<motion\.(\w+)(\s)/, '<motion.$1 {...rest}$2');

  trace.fn('event-prop-forwarding:applied', {});
  return out;
}
