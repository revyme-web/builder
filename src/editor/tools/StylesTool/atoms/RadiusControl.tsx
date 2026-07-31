// RadiusControl.tsx — Self-contained border-radius ToolAtom with SpacingControl.
// Includes "Radius Editor" for fancy 8-value visual editing via canvas overlay.
// When fancy shape active: shows single row with swatch + "Edit" + × (same style as Shadow).

import { useCallback, useEffect } from 'react';
import LocaleBoundPill, { useLocaleStyleOverrides } from '@/editor/controls/LocaleBoundPill';
import { useSetAtom, useAtomValue } from 'jotai';
import { SpacingControl, ControlActionRow, RemoveButton, ColorSwatch } from '../../../controls';
import { UnifiedControlProvider, ControlRow, useControlContext } from '../../../controls/unified';
import { parseShorthand } from '@/shared/css-utils';
import { parseFancyRadius, formatFancyRadius, isFancyRadius } from '@/shared/border-radius-utils';
import { activeFancyRadiusAtom, fancyRadiusCallbackAtom, fancyRadiusCommitAtom } from '@/code/stores/borderradius-store';
import { selectedIdsAtom } from '@/code/stores/store';
import { updateNodeStyles, getContentRoot } from '@/canvas/node-ops';
import type { AtomProps } from '../../../controls/unified/types';
import type { FancyRadiusData } from '@/shared/border-radius-utils';
import { trace } from '@/shared/debug-trace';

const RADIUS_KEYS_TO_CLEAR = {
  borderTopLeftRadius: '',
  borderTopRightRadius: '',
  borderBottomRightRadius: '',
  borderBottomLeftRadius: '',
};

function RadiusAtom() {
  const { value, onChange, onChangeMultiple, onChangeLive, node, mode, allProps } = useControlContext();
  const styles = allProps;
  const setActiveFancyRadius = useSetAtom(activeFancyRadiusAtom);
  const setFancyRadiusCallback = useSetAtom(fancyRadiusCallbackAtom);
  const setFancyRadiusCommit = useSetAtom(fancyRadiusCommitAtom);
  const activeFancyRadius = useAtomValue(activeFancyRadiusAtom);
  const selectedIds = useAtomValue(selectedIdsAtom);

  // Locale `:lang()` overrides → the blue Locale pill replaces the cluster
  // (body reopens the Localize popup with the saved conditions; × clears).
  const radiusLocaleOverrides = useLocaleStyleOverrides('borderRadius', node?.id ?? null);

  const sh = parseShorthand(value);
  const corners = [
    styles.borderTopLeftRadius || sh[0], styles.borderTopRightRadius || sh[1],
    styles.borderBottomRightRadius || sh[2], styles.borderBottomLeftRadius || sh[3],
  ] as [string, string, string, string];

  const isFancy = isFancyRadius(value);
  const isEditorActive = !!activeFancyRadius;

  // Clear overlay when component unmounts (selection changed, node deselected)
  useEffect(() => {
    return () => {
      setActiveFancyRadius(null);
      setFancyRadiusCallback(null);
      setFancyRadiusCommit(null);
    };
  }, [setActiveFancyRadius, setFancyRadiusCallback, setFancyRadiusCommit]);

  const handleOpenEditor = useCallback(() => {
    const data = value ? parseFancyRadius(value) : parseFancyRadius('50%');
    trace.action('radius-editor:open', { currentValue: value });

    // LIVE callback — fires on every pointermove. Patches the iframe element
    // inline (DOM-only via updateNodeStyles+domOnly) and bumps the atom for the
    // overlay handles. NO mutation queue, NO parser re-run, NO renderer cycle —
    // those would race with the next pointermove and the renderer would
    // overwrite the inline style with a stale parsed value, causing oscillation.
    setFancyRadiusCallback(() => (newData: FancyRadiusData) => {
      const css = formatFancyRadius(newData);
      if (mode === 'direct') {
        // StylesTool — patch the SELECTED node's borderRadius inline (DOM-only), clearing longhands.
        const contentEl = getContentRoot();
        if (contentEl) {
          for (const id of selectedIds) {
            updateNodeStyles({
              id,
              styles: { borderRadius: css, ...RADIUS_KEYS_TO_CLEAR },
              contentEl,
              domOnly: true,
            });
          }
        }
      } else {
        // ComponentPropsTool variable (variableDefault): the radius renders on the EXPANDED instance
        // via the variable/conditional, NOT the selected wrapper — route through the live channel
        // (→ previewProp) so the right element updates per frame. Commit still goes through onChangeMultiple.
        onChangeLive(css);
      }
      setActiveFancyRadius(newData);
    });

    // COMMIT callback — fires once on pointerup. This is the only write that
    // goes through the mutation queue / code generator.
    setFancyRadiusCommit(() => (newData: FancyRadiusData) => {
      const css = formatFancyRadius(newData);
      onChangeMultiple({
        borderRadius: css,
        ...RADIUS_KEYS_TO_CLEAR,
      });
      setActiveFancyRadius(newData);
      trace.action('radius-editor:commit', { css });
    });

    setActiveFancyRadius(data);
  }, [value, onChangeMultiple, onChangeLive, mode, selectedIds, setActiveFancyRadius, setFancyRadiusCallback, setFancyRadiusCommit]);

  const handleCloseEditor = useCallback(() => {
    setActiveFancyRadius(null);
    setFancyRadiusCallback(null);
    setFancyRadiusCommit(null);
    trace.action('radius-editor:close');
  }, [setActiveFancyRadius, setFancyRadiusCallback, setFancyRadiusCommit]);

  const handleRemoveCustomShape = useCallback(() => {
    onChangeMultiple({
      borderRadius: '16px',
      ...RADIUS_KEYS_TO_CLEAR,
    });
    setActiveFancyRadius(null);
    setFancyRadiusCallback(null);
    setFancyRadiusCommit(null);
    trace.action('radius-editor:remove-custom');
  }, [onChangeMultiple, setActiveFancyRadius, setFancyRadiusCallback, setFancyRadiusCommit]);

  // Locale-localized radius → the blue Locale pill (click reopens the
  // Localize popup with the saved conditions; × clears all locales).
  if (radiusLocaleOverrides.length > 0 && node?.id) {
    return (
      <LocaleBoundPill
        property="borderRadius"
        propertyLabel="Radius"
        nodeId={node.id}
        baseValue={value || ''}
        onChangeBase={(v) => onChange(v)}
      />
    );
  }

  // When fancy shape exists: show single row like Shadow (swatch + Edit + ×)
  if (isFancy || isEditorActive) {
    const bgColor = styles.backgroundColor || '#666';
    return (
      <ControlActionRow onClick={isEditorActive ? handleCloseEditor : handleOpenEditor}>
        <ColorSwatch style={{
          backgroundColor: bgColor,
          borderRadius: isFancy ? value : '50%',
        }} />
        <span className="flex-1 text-xs text-[var(--text-primary)] truncate text-left">
          Edit Radius
        </span>
        <RemoveButton onClick={(e) => { e.stopPropagation(); handleRemoveCustomShape(); }} />
      </ControlActionRow>
    );
  }

  // Normal mode: 4-corner inputs + Editor button
  return (
    <div className="flex flex-col gap-2 w-full">
      <SpacingControl
        values={corners}
        labels={['TL', 'TR', 'BR', 'BL']}
        onChange={(index, val) => {
          const c = [...corners]; c[index] = val;
          onChangeMultiple({
            borderRadius: '', borderTopLeftRadius: c[0], borderTopRightRadius: c[1],
            borderBottomRightRadius: c[2], borderBottomLeftRadius: c[3],
          });
        }}
        onChangeAll={(val) => onChangeMultiple({
          borderRadius: val, borderTopLeftRadius: '', borderTopRightRadius: '',
          borderBottomRightRadius: '', borderBottomLeftRadius: '',
        })}
        // Live patch sets ONLY the `borderRadius` shorthand (the unified
        // provider's `property`). Setting the shorthand resets all four corner
        // longhands in one CSSOM write — do NOT also send empty longhand clears
        // here: as SEPARATE per-key patches they run AFTER the shorthand and
        // `el.style.borderTopLeftRadius = ''` strips the corners the shorthand
        // just set, wiping the live preview to 0. The longhand clears are only
        // needed for the source COMMIT (onChangeAll), which is a code write, not
        // CSSOM. Mirrors how Fill/Color live-patch a single property.
        onChangeAllLive={(val) => onChangeLive(val)}
      />
      {/* The on-canvas Radius Editor needs a real node to draw the overlay on — meaningless when
          editing a variable's default value (variableDefault mode, no node). Hide it there. */}
      {mode !== 'variableDefault' && (
        <ControlActionRow onClick={handleOpenEditor}>
          <span className="text-xs text-[var(--text-secondary)]">Radius Editor</span>
        </ControlActionRow>
      )}
    </div>
  );
}

export function RadiusControl({ mode = 'direct', ...mp }: AtomProps) {
  return (
    <UnifiedControlProvider property="borderRadius" defaultValue="" mode={mode} {...mp}>
      <ControlRow label="Radius"><RadiusAtom /></ControlRow>
    </UnifiedControlProvider>
  );
}
