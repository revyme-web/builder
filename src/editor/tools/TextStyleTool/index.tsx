// TextStyleTool — Complete text styling controls (pure composition).
// Each sub-control is a self-contained atom in ./atoms/.
// Reads/writes via useTextStyles hook or useControl depending on property type.

import { ToolSection, ToolDivider } from '../../controls';
import { CreateVariableGate } from '../../controls/create-variable-gate';
import { LocalizeGate } from '../../controls/localize-gate';
import { useControl } from '../../controls/ControlProvider';
import { useAtomValue } from 'jotai';
import { isMapTemplateSelectedAtom } from '@/code/stores/store';
import { trace } from '@/shared/debug-trace';
import {
  TypographyPresetControl,
  ContentControl, TextColorControl, TextFillControl,
  AlignControl, AdjustControl, TextPropertyControl,
  ElementPropertyControl, FontFamilyControl,
  DecorationControl, ShadowControl, StrokeControl,
} from './atoms';

export default function TextStyleTool() {
  const { node, styles } = useControl();
  const isMapTemplate = useAtomValue(isMapTemplateSelectedAtom);

  // PropertiesPanel only renders TextStyleTool when isText is true — no need to re-check.
  if (!node) return null;

  // When a typography preset is active, hide all preset-controlled properties
  const hasPreset = !!styles.fontFamily?.startsWith('var(--typo-');

  trace.fn('TextStyleTool:render', { nodeId: node.id, nodeType: node.type, hasPreset, isMapTemplate });

  return (
    <>
      {/* Only Content / Color / Font Size may become variables. Gate the whole
          section to hide "Create Variable", then re-allow those three. */}
      {/* LOCALIZE is off for every text STYLE row — Content only (user call
          2026-08-10). The `:lang()` rule targets `[data-id]` with `!important`,
          and rich-text runs are spans with no `data-id`, so a per-locale value
          here overrides every run in the node: localizing a two-colour headline
          flattens it to one colour in that language. Split-text animations
          produce the same spans at runtime. Content stays because that IS the
          translation — it routes to `messages/{locale}.json`, not to CSS.
          Same gate the Animation tool uses for its motion props. */}
      <LocalizeGate hidden>
      <CreateVariableGate hidden>
        <ToolSection title="Text" collapsible>
          {!isMapTemplate && <TypographyPresetControl />}
          <LocalizeGate hidden={false}>
            <CreateVariableGate hidden={false}><ContentControl /></CreateVariableGate>
          </LocalizeGate>
          <CreateVariableGate hidden={false}><TextColorControl /></CreateVariableGate>
          <TextFillControl />
          <AlignControl />
          <AdjustControl />
          {!hasPreset && (
            <>
              <CreateVariableGate hidden={false}>
                <TextPropertyControl property="fontSize" label="Font Size" />
              </CreateVariableGate>
              <FontFamilyControl />
              <TextPropertyControl property="fontWeight" label="Weight" />
              <TextPropertyControl property="fontStyle" label="Italic" />
              <TextPropertyControl property="letterSpacing" label="Spacing" />
              <TextPropertyControl property="lineHeight" label="Line Height" />
              <ElementPropertyControl property="textTransform" label="Transform" />
              <ElementPropertyControl property="whiteSpace" label="Whitespace" />
              <ElementPropertyControl property="textOverflow" label="Overflow" />
              <ElementPropertyControl property="writingMode" label="Mode" />
              <DecorationControl />
              <ShadowControl />
              <StrokeControl />
            </>
          )}
        </ToolSection>
      </CreateVariableGate>
      </LocalizeGate>
      <ToolDivider />
    </>
  );
}
