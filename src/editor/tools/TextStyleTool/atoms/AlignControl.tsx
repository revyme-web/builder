// AlignControl.tsx — Text alignment control.
// Reads from text.get('textAlign'), uses ToolSegmentedControl with compact size and SVG icons.

import { ToolSegmentedControl } from '../../../controls';
import { useTextStyles } from '../../../hooks/useTextStyles';
import { trace } from '@/shared/debug-trace';

export function AlignControl() {
  const text = useTextStyles();
  const { value, isMixed } = text.get('textAlign');

  trace.fn('AlignControl:render', { value, isMixed, isEditing: text.isEditing });

  return (
    <div className="flex items-center justify-between w-full">
      {/* `pl-[18px] -ml-[18px]` mirrors ControlLabel's gutter so the value
          column lines up with adjacent rows that DO render a chevron. The
          previous `<div className="w-full">` wrapper around the segmented
          control limited it to the wrapper's auto width — visible as the
          Align/Adjust rows sitting narrower than Color/Fill/Font Size.
          Removing the wrapper lets ToolSegmentedControl's own `w-full` fill
          the flex parent's remaining width like every other right-side
          control. Same change applied to AdjustControl. */}
      <span className="w-3/4 text-xs font-bold text-[var(--text-secondary)] pl-[18px] -ml-[18px]">Align</span>
      <ToolSegmentedControl
        value={isMixed ? '' : (value || 'left')}
        onChange={(v) => text.set('textAlign', v)}
        options={[
          { value: 'left', icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="18" y2="18"/></svg> },
          { value: 'center', icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg> },
          { value: 'right', icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="6" y1="18" x2="21" y2="18"/></svg> },
          { value: 'justify', icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg> },
        ]}
        size="compact"
      />
    </div>
  );
}
