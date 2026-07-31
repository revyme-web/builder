// AdjustControl.tsx — Vertical alignment for text inside its own box.
//
// CSS `vertical-align` (the historical pick for this control) only affects
// inline-level elements / table cells. On a `<p>` with explicit width and
// height it does nothing — the text just clings to the top of the block.
// To get top / center / bottom, the element has to lay its content out via
// flex with `flex-direction: column`, then `justify-content` controls
// where the text sits along the (vertical) main axis.
//
// We write three styles atomically: `display: flex`, `flex-direction:
// column`, and `justify-content: <value>`. If the user already has these
// (TextCreator's draw-mode default does), the first two are no-ops. We
// avoid writing them when the value is `flex-start` (= the default) so
// reverting to the top doesn't leave residual flex inline styles on
// elements that never had them.

import { ToolSegmentedControl } from '../../../controls';
import { useControl } from '../../../controls/ControlProvider';
import { trace } from '@/shared/debug-trace';

export function AdjustControl() {
  const { styles, updateMultipleStyles } = useControl();
  // The active value comes from `justify-content` if flex is in play,
  // otherwise default to `flex-start` (the natural top-of-box position
  // for any text element). `super`/`baseline`/`sub` from the legacy
  // schema collapse to `flex-start` so old documents don't render with
  // a confusingly-active button.
  const isFlexCol =
    styles.display === 'flex' && (styles.flexDirection === 'column' || styles.flexDirection === 'column-reverse');
  const rawJustify = isFlexCol ? styles.justifyContent : '';
  const value =
    rawJustify === 'center' ? 'center' :
    rawJustify === 'flex-end' ? 'flex-end' :
    'flex-start';

  trace.fn('AdjustControl:render', { value, display: styles.display, justifyContent: styles.justifyContent });

  const setAdjust = (next: string) => {
    // Always set display + flex-direction so the control works even on
    // elements that started without flex. Empty string on
    // justifyContent (top = default) clears the override entirely so
    // the inline style stays minimal.
    const updates: Record<string, string> = {
      display: 'flex',
      flexDirection: 'column',
      justifyContent: next === 'flex-start' ? '' : next,
    };
    updateMultipleStyles(updates);
  };

  return (
    <div className="flex items-center justify-between w-full">
      {/* See AlignControl for the full rationale — gutter on the label
          + drop the `<div w-full>` wrapper so the segmented control fills
          the same width as Color / Fill / Font Size on adjacent rows. */}
      <span className="w-3/4 text-xs font-bold text-[var(--text-secondary)] pl-[18px] -ml-[18px]">Adjust</span>
      <ToolSegmentedControl
        value={value}
        onChange={setAdjust}
        options={[
          { value: 'flex-start', icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg> },
          { value: 'center', icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg> },
          { value: 'flex-end', icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg> },
        ]}
        size="compact"
      />
    </div>
  );
}
