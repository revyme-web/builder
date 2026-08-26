// PositionTypeControl.tsx — Position type dropdown with visual stability on switch.

import { useCallback } from 'react';
import { ToolRow, ToolSelect } from '../../controls';
import { findNodeComputedStyle } from '@/canvas/node-ops';
import { getAbsoluteCanvasRectById, absoluteToRelativeById } from '@/canvas/canvas-math';
import { getNodesSnapshot } from '@/code/stores/store';
import { useNode } from '@/code/stores/node-family';
import { transformManager } from '@/canvas/transform';
import { toRelative } from '@/shared/position-utils';
import { applyReplicaClearSemantics } from './replica-clears';
import { getCSSPropertyOptions } from '../../controls/css-property-options';
import { gatePositionTypeOptions } from '@/shared/pin-utils';
import { trace } from '@/shared/debug-trace';

interface Props {
  position: string;
  nodeId: string;
  vpId: string;
  existingTransform?: string;
  onUpdateMultiple: (styles: Record<string, string>) => void;
}

const OPTIONS = getCSSPropertyOptions('position')!;

export default function PositionTypeControl({ position, nodeId, vpId, existingTransform, onUpdateMultiple }: Props) {
  const handleChange = useCallback((newType: string) => {
    if (newType === position) return;
    let styles: Record<string, string>;

    if (newType === 'static') {
      styles = { position: '', left: '', top: '', right: '', bottom: '' };
    } else if (newType === 'relative') {
      styles = toRelative(existingTransform);
    } else if (newType === 'absolute' || newType === 'fixed') {
      // Preserve the element's VISUAL spot when it leaves the flow. Compute its position relative
      // to its parent in canvas CSS px via the SAME bridge-aware helpers drag/creators use —
      // `getAbsoluteCanvasRectById` (child's canvas rect, iframe-offset + zoom corrected) then
      // `absoluteToRelativeById` (subtract the parent's canvas offset). The previous ad-hoc
      // screen-rect ÷ scale capture mismeasured against the canvas origin, so a flex child jumped
      // to its page-absolute coords (e.g. top:1027 inside a 266px parent → off-screen).
      const transform = transformManager.getTransform();
      const parentId = getNodesSnapshot().get(nodeId)?.parentId ?? null;
      const childRect = getAbsoluteCanvasRectById(nodeId, vpId, transform);
      if (childRect && parentId) {
        const rel = absoluteToRelativeById(childRect.left, childRect.top, parentId, vpId, transform);
        styles = { position: newType, left: `${Math.round(rel.x)}px`, top: `${Math.round(rel.y)}px` };
      } else {
        // No rect available — still apply the type change (user repositions after).
        styles = { position: newType, left: '0px', top: '0px' };
      }
      // Clear inset when coming from absolute
      if (position === 'absolute') {
        styles.right = '';
        styles.bottom = '';
      }
    } else if (newType === 'sticky') {
      styles = { position: 'sticky', left: '', top: '0px', right: '', bottom: '' };
    } else {
      styles = { position: newType };
    }

    trace.action('position-type:change', { nodeId, from: position, to: newType });
    // Non-primary channel: '' clears of base-carried position/inset/transform
    // must become explicit neutrals, else the base cascades back through the
    // deleted variant/band key (same law as PinControl / layout-injection).
    onUpdateMultiple(applyReplicaClearSemantics(nodeId, vpId, styles));
  }, [position, nodeId, vpId, existingTransform, onUpdateMultiple]);

  // Context-gate the position types (design-tool parity):
  //   • Absolute  — always valid (free positioning inside any parent).
  //   • Relative / Sticky — only when the PARENT has a layout (flex/grid); in a free/no-layout
  //     parent there's no flow to participate in, so the child can only be Absolute.
  //   • Fixed     — only for a DIRECT child of the viewport (page root): it's positioned against
  //     the viewport, which is meaningless nested inside another frame.
  // Disabled options grey out in the dropdown. The CURRENT value is never disabled (so it always
  // renders selected, even if the node is in a state the rules would otherwise forbid).
  const node = useNode(nodeId);
  const parentId = node?.parentId ?? null;
  const parentNode = useNode(parentId);
  const parentDisplay = (parentId ? findNodeComputedStyle(parentId, vpId, 'display') : '')
    || (parentId ? parentNode?.styles?.display : '') || '';
  const parentHasLayout = /^(inline-)?(flex|grid)$/.test(parentDisplay);
  const isViewportChild = parentId === 'root';
  const options = gatePositionTypeOptions(OPTIONS, { position, parentHasLayout, isViewportChild });

  return (
    <ToolRow label="Type">
      <ToolSelect value={position} onChange={handleChange} options={options} />
    </ToolRow>
  );
}
