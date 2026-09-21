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
import { useControl } from '../../controls/ControlProvider';
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

/** What "match the primary's positioning" clears. Width/Height are excluded —
 *  they have their own labels and resets in the Dimensions section. */
export const POSITION_FAMILY = ['position', 'left', 'top', 'right', 'bottom'] as const;

/** The write that puts a replica/variant back in sync with the primary.
 *
 *  Plain `''` DELETES the key on a non-primary channel (an @media decl or a
 *  variant entry), so the primary's value cascades back — which is the whole
 *  point. It deliberately does NOT go through `applyReplicaClearSemantics`,
 *  which converts a `''` into an explicit neutral (`auto`) to stop the base
 *  bleeding through: right for UNPINNING a side, exactly wrong for a reset.
 *
 *  `effective` is the tile's resolved styles. A size of `auto` there is not a
 *  size the user chose — it is the NEUTRAL that entering full-inset mode wrote
 *  (`toInsetMode` emits `width: ''`, which `applyReplicaClearSemantics` turns
 *  into `auto` on a replica channel). Clearing the insets while leaving it
 *  behind left the node with nothing to stretch between: it computed 0×0 and
 *  vanished (user report 2026-09-21). So an `auto` size is part of the
 *  positioning and clears with it, while a real px/% override is a size the
 *  user set and survives. */
export function positionResetStyles(effective?: Record<string, string>): Record<string, string> {
  const cleared: Record<string, string> = {};
  for (const k of POSITION_FAMILY) cleared[k] = '';
  for (const k of ['width', 'height'] as const) {
    const v = effective?.[k]?.trim();
    if (v === 'auto' || v === '') cleared[k] = '';
  }
  return cleared;
}

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

  // RESET OVERRIDE for the whole positioning family. Width/Height each carry
  // their own label (and reset), but the insets had none — so a replica or
  // variant positioned independently could never be put back in sync with the
  // primary (user request 2026-09-21). The Type row hosts it because it is the
  // one row that describes the node's positioning as a whole.
  const { hasOverride, styles: effectiveStyles } = useControl();
  const positionOverridden = POSITION_FAMILY.some((k) => hasOverride(k));
  const resetPositionOverride = useCallback(() => {
    trace.action('position-type:reset-override', { nodeId, vpId, keys: POSITION_FAMILY });
    onUpdateMultiple(positionResetStyles(effectiveStyles));
  }, [nodeId, vpId, onUpdateMultiple, effectiveStyles]);

  return (
    <ToolRow
      label="Type"
      // `position` is not a variable-able property — offering "Create Variable"
      // here advertises something that cannot work.
      hideCreateVariable
      overridden={positionOverridden}
      onResetOverride={positionOverridden ? resetPositionOverride : undefined}
    >
      <ToolSelect value={position} onChange={handleChange} options={options} />
    </ToolRow>
  );
}
