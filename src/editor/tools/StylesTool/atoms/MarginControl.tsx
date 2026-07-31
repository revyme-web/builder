// MarginControl.tsx — Self-contained margin ToolAtom with SpacingControl.

import { SpacingControl } from '../../../controls';
import { UnifiedControlProvider, ControlRow, useControlContext } from '../../../controls/unified';
import { LocalePillOr } from '@/editor/controls/LocaleBoundPill';
import { resolveSpacingSides } from '@/shared/css-utils';
import type { AtomProps } from '../../../controls/unified/types';

function MarginAtom() {
  const { onChangeMultiple, onChangeLive, node, mode, allProps } = useControlContext();
  const styles = allProps;
  // Order-aware effective sides — see PaddingControl: a trailing `margin`
  // shorthand out-ranks earlier longhands in React key order.
  const sides = resolveSpacingSides(styles, 'margin');

  return (
    <SpacingControl
      values={sides}
      labels={['T', 'R', 'B', 'L']}
      allowNegative
      onChange={(index, val) => {
        const s = [...sides]; s[index] = val;
        onChangeMultiple({
          margin: '', marginTop: s[0], marginRight: s[1],
          marginBottom: s[2], marginLeft: s[3],
        });
      }}
      onChangeAll={(val) => onChangeMultiple({
        margin: val, marginTop: '', marginRight: '', marginBottom: '', marginLeft: '',
      })}
      // Live patch sets ONLY the `margin` shorthand (resets all 4 sides in one
      // CSSOM write). Empty longhand clears would run after the shorthand as
      // separate patches and strip the sides it just set. Clears are for the
      // source COMMIT (onChangeAll) only. See RadiusControl for the rationale.
      onChangeAllLive={(val) => onChangeLive(val)}
    />
  );
}

export function MarginControl({ mode = 'direct', ...mp }: AtomProps) {
  return (
    <UnifiedControlProvider property="margin" defaultValue="" mode={mode} {...mp}>
      <ControlRow label="Margin"><LocalePillOr property="margin" label="Margin"><MarginAtom /></LocalePillOr></ControlRow>
    </UnifiedControlProvider>
  );
}
