// PaddingControl.tsx — Self-contained padding ToolAtom with SpacingControl.

import { SpacingControl } from '../../../controls';
import { UnifiedControlProvider, ControlRow, useControlContext } from '../../../controls/unified';
import { LocalePillOr } from '@/editor/controls/LocaleBoundPill';
import { resolveSpacingSides } from '@/shared/css-utils';
import type { AtomProps } from '../../../controls/unified/types';

function PaddingAtom() {
  const { onChangeMultiple, onChangeLive, node, mode, allProps } = useControlContext();
  const styles = allProps;
  // Order-aware effective sides — a legacy object mixing longhands with a
  // TRAILING `padding` shorthand renders the shorthand (React key order),
  // so the inputs must show that too, not the out-ranked longhands.
  const sides = resolveSpacingSides(styles, 'padding');

  return (
    <SpacingControl
      values={sides}
      labels={['T', 'R', 'B', 'L']}
      onChange={(index, val) => {
        const s = [...sides]; s[index] = val;
        onChangeMultiple({
          padding: '', paddingTop: s[0], paddingRight: s[1],
          paddingBottom: s[2], paddingLeft: s[3],
        });
      }}
      onChangeAll={(val) => onChangeMultiple({
        padding: val, paddingTop: '', paddingRight: '', paddingBottom: '', paddingLeft: '',
      })}
      // Live patch sets ONLY the `padding` shorthand (resets all 4 sides in one
      // CSSOM write). Sending empty longhand clears here would, as separate
      // per-key patches, run after the shorthand and strip the sides it just
      // set — wiping the live preview. The clears are for the source COMMIT
      // (onChangeAll) only. See RadiusControl for the full rationale.
      onChangeAllLive={(val) => onChangeLive(val)}
    />
  );
}

export function PaddingControl({ mode = 'direct', ...mp }: AtomProps) {
  return (
    <UnifiedControlProvider property="padding" defaultValue="" mode={mode} {...mp}>
      <ControlRow label="Padding"><LocalePillOr property="padding" label="Padding"><PaddingAtom /></LocalePillOr></ControlRow>
    </UnifiedControlProvider>
  );
}
