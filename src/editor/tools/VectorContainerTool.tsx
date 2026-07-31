// VectorContainerTool.tsx — Slim panel for a VECTOR VARIANT CARD (icon-set
// card) or a top-level vector container. Two sections:
//
//   • Vector → Fill   — the card's OWN background (`backgroundColor`), full-width.
//   • Selection → Colors — every distinct fill used by the inner SVG shapes,
//     listed in the SelectionTool format (one editable swatch row per color).
//     Editing a row recolors EVERY child shape that shares that fill at once
//     (fans `fill` to each via `updateSvgAttrs`).
//
// The Selection aggregation walks the parsed node tree (`collectGroupShapeSvgs`,
// shared with GroupFillControl) rather than scanning source, so each colour
// carries the child-shape ids it must recolor.

import { useCallback } from 'react';
import { useAtomValue } from 'jotai';
import { useNodesComputed } from '@/code/stores/node-family';
import { presetTokensAtom } from '@/code/stores/preset-store';
import { useControl } from '@/editor/controls/ControlProvider';
import { ToolSection, ToolDivider } from '@/editor/controls';
import ControlLabel from '@/editor/controls/ControlLabel';
import ColorInput from '@/editor/controls/ColorInput';
import { collectGroupShapeSvgs } from './StylesTool/atoms/GroupFillControl';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { getViewportPrefix } from '@/canvas/node-ops';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import { trace } from '@/shared/debug-trace';
import { parseVarRef } from '@/shared/css-utils';

export default function VectorContainerTool() {
  const { node, styles, updateStyle, updateStyleLive, vpId } = useControl();
  const colorPresets = useAtomValue(presetTokensAtom).filter((t) => t.category === 'color');

  // ─── Vector > Fill — the card's own backgroundColor ──────────────────────
  const fillValue = styles.backgroundColor || '';
  const handleFillChange = useCallback((color: string) => {
    trace.action('vector-container:fill-change', { nodeId: node?.id, color });
    updateStyle('backgroundColor', color);
  }, [node?.id, updateStyle]);

  // Per-frame picker drag → DOM-only patch (no source write); commit lands once
  // on release via handleFillChange.
  const handleFillLive = useCallback((color: string) => {
    updateStyleLive('backgroundColor', color);
  }, [updateStyleLive]);

  // ─── Selection > Colors — distinct inner-shape fills (editable) ───────────
  const colorGroups = useNodesComputed((nodes) => {
    const shapes = collectGroupShapeSvgs(node, nodes);
    const map = new Map<string, string[]>(); // fill → [child svgId]
    for (const { svgId, shape } of shapes) {
      const fill = (shape.attrs?.fill || '#000000').trim();
      if (!fill || fill.toLowerCase() === 'none' || fill.startsWith('url(')) continue;
      const arr = map.get(fill) ?? [];
      arr.push(svgId);
      map.set(fill, arr);
    }
    // Dominant colour (most shapes) first.
    return Array.from(map.entries())
      .sort((a, b) => b[1].length - a[1].length)
      .map(([color, ids]) => ({ color, ids }));
  }, [node]);

  const recolor = useCallback((currentColor: string, ids: string[], newColor: string) => {
    let finalColor = newColor;
    // The preset × calls onChange('') (ColorInput) — UNBIND it: resolve the
    // current `var(--color-…)` token to its raw hex so the shapes keep their
    // colour but drop the preset binding. An empty value on a non-preset is a
    // no-op (nothing to remove).
    if (!finalColor) {
      const name = currentColor.startsWith('var(--color-') ? parseVarRef(currentColor) : null;
      if (!name) return;
      finalColor = colorPresets.find((t) => t.name === name)?.value || '#000000';
    }
    trace.action('vector-container:selection-recolor', { count: ids.length, from: currentColor, color: finalColor });
    // Live DOM patch (so the shapes recolor WHILE the picker drags) + queue the
    // source commit — same dual write GroupFillControl uses.
    const vpPrefix = getViewportPrefix(vpId);
    const bridge = getCanvasBridge() as {
      setChildShapeAttribute?: (parent: string, vp: string, idx: number, attr: string, value: string | null) => void;
    };
    for (const svgId of ids) {
      queueMutation({ type: 'updateSvgAttrs', nodeId: svgId, attrs: { fill: finalColor }, childIndex: 0 });
      bridge.setChildShapeAttribute?.(svgId, vpPrefix, 0, 'fill', finalColor);
    }
  }, [vpId, colorPresets]);

  // Per-frame picker drag → bridge paint only (no per-shape queueMutation). The
  // commit fans out the real source writes once on release via `recolor`. The
  // preset-unbind (empty value) path is commit-only, so live skips empties.
  const recolorLive = useCallback((_currentColor: string, ids: string[], newColor: string) => {
    if (!newColor) return;
    const vpPrefix = getViewportPrefix(vpId);
    const bridge = getCanvasBridge() as {
      setChildShapeAttribute?: (parent: string, vp: string, idx: number, attr: string, value: string | null) => void;
    };
    for (const svgId of ids) {
      bridge.setChildShapeAttribute?.(svgId, vpPrefix, 0, 'fill', newColor);
    }
  }, [vpId]);

  if (!node) return null;

  return (
    <>
      <ToolSection title="Vector">
        <div className="flex items-start justify-between w-full">
          <div className="h-8 flex items-center w-3/4">
            <ControlLabel plain label="Fill" property="backgroundColor" />
          </div>
          <div className="flex flex-col gap-1.5 w-full">
            <ColorInput value={fillValue} onChange={handleFillChange} onChangeLive={handleFillLive} showAlpha />
          </div>
        </div>
      </ToolSection>

      {colorGroups.length > 0 && (
        <>
        <ToolDivider />
        <ToolSection title="Selection">
          <div className="flex items-start justify-between w-full">
            <div className="h-8 flex items-center w-3/4">
              <ControlLabel plain label="Colors" property="__vector-colors" />
            </div>
            <div className="flex flex-col gap-1.5 w-full">
              {colorGroups.map(({ color, ids }) => (
                <ColorInput
                  key={ids[0]}
                  value={color}
                  onChange={(c) => recolor(color, ids, c)}
                  onChangeLive={(c) => recolorLive(color, ids, c)}
                  showAlpha
                />
              ))}
            </div>
          </div>
        </ToolSection>
        </>
      )}
    </>
  );
}
