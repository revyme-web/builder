// ImageTool.tsx — Image source, alt text, objectFit, and objectPosition controls.
// Shows only when an <img> or <Image> element is selected.
// Map-aware: when inside .map(), reads src/alt from data array item and writes via updateMapItem.
// Uses ImageSearchModal for Unsplash/upload image selection.
//
// Layout — rows mirror the Fill control pattern: every value column is a
// `ControlLabel` + a single-row picker/pill, so binding menus, override
// indicators, and Used-By rows all show up automatically. The Source row
// uses a ColorSwatch thumbnail + label, identical to Fill's image swatch.

import { useState, useCallback, useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { ToolSection, ToolInput, ToolSelect, ControlLabel, ControlActionRow, ColorSwatch } from '../controls';
import { useControl } from '../controls/ControlProvider';
import { CmsBoundPill } from '../controls/CmsBoundPill';
import { mapItemIndexAtom, mapContextAtom } from '@/code/stores/store';
import { queueMutation } from '@/code/mutation/mutation-queue';
import { getViewportPrefix } from '@/canvas/node-ops';
import { getCanvasBridge } from '@/canvas/canvas-bridge';
import ImageSearchModal from '../ui/ImageSearchModal';
import { trace } from '@/shared/debug-trace';

// ─── Options ────────────────────────────────────────────────────────────────

const OBJECT_FIT_OPTIONS = [
  { value: 'cover', label: 'Cover' },
  { value: 'contain', label: 'Contain' },
  { value: 'fill', label: 'Fill' },
  { value: 'none', label: 'None' },
  { value: 'scale-down', label: 'Scale Down' },
];

const OBJECT_POSITION_OPTIONS = [
  { value: 'center', label: 'Center' },
  { value: 'top', label: 'Top' },
  { value: 'bottom', label: 'Bottom' },
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
  { value: 'top left', label: 'Top Left' },
  { value: 'top right', label: 'Top Right' },
  { value: 'bottom left', label: 'Bottom Left' },
  { value: 'bottom right', label: 'Bottom Right' },
];

// Transparent-checker pattern for the empty source swatch — same as Fill
// uses for "no value yet". Drops into ColorSwatch's style prop.
const ALPHA_CHECKER_STYLE: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(45deg, rgba(255,255,255,0.15) 25%, transparent 25%), ' +
    'linear-gradient(-45deg, rgba(255,255,255,0.15) 25%, transparent 25%), ' +
    'linear-gradient(45deg, transparent 75%, rgba(255,255,255,0.15) 75%), ' +
    'linear-gradient(-45deg, transparent 75%, rgba(255,255,255,0.15) 75%)',
  backgroundSize: '6px 6px',
  backgroundPosition: '0 0, 0 3px, 3px -3px, -3px 0',
};

// ─── ImageTool ──────────────────────────────────────────────────────────────

export default function ImageTool() {
  const ctx = useControl();
  const { node, nodeId, styles, vpId, updateStyle, cmsBinding } = ctx;

  // Only show for img/Image/motion.img elements
  if (!node || (node.type !== 'img' && node.type !== 'Image' && node.type !== 'motion.img')) return null;

  return <ImageToolInner
    nodeId={nodeId!}
    node={node}
    styles={styles}
    vpId={vpId}
    updateStyle={updateStyle}
    cmsBinding={cmsBinding}
  />;
}

/** Inner component — avoids hooks-after-early-return issues */
function ImageToolInner({
  nodeId,
  node,
  styles,
  vpId,
  updateStyle,
  cmsBinding,
}: {
  nodeId: string;
  node: NonNullable<ReturnType<typeof useControl>['node']>;
  styles: Record<string, string>;
  vpId: string;
  updateStyle: (key: string, value: string) => void;
  cmsBinding: ReturnType<typeof useControl>['cmsBinding'];
}) {
  const [imageModalOpen, setImageModalOpen] = useState(false);

  // CMS binding state — when src is bound to a CMS image field, the source
  // row swaps to a CmsBoundPill (matches Fill's bound-state UI). The
  // ControlLabel's menu handles binding/unbinding for unbound rows
  // automatically — no extra chain icon needed.
  const isSrcCmsBound = !!cmsBinding?.getBindingForProperty('src');

  // Map context — when inside .map(), attrs are bound to data fields
  const mapItemIndex = useAtomValue(mapItemIndexAtom);
  const mapContext = useAtomValue(mapContextAtom);
  const isInMap = mapItemIndex != null && mapContext != null;

  // Find attr binding field names for src and alt
  const srcBinding = node.attrBindings?.find(b => b.property === 'src');
  const altBinding = node.attrBindings?.find(b => b.property === 'alt');

  // Resolve current src/alt — from map data if bound, otherwise from node attrs
  const mapItem = isInMap ? mapContext.mapData[mapItemIndex] : null;
  const src = (isInMap && srcBinding && mapItem)
    ? (mapItem[srcBinding.field] ?? '')
    : (node.attrs?.src ?? '');
  const alt = (isInMap && altBinding && mapItem)
    ? (mapItem[altBinding.field] ?? '')
    : (node.attrs?.alt ?? '');

  const [localAlt, setLocalAlt] = useState(alt);
  const objectFit = styles.objectFit || 'cover';
  const objectPosition = styles.objectPosition || 'center';

  // Sync local alt when node/map item changes
  useEffect(() => {
    setLocalAlt(alt);
  }, [nodeId, alt, mapItemIndex]);

  // ─── Image selection ──────────────────────────────────────────────
  const handleImageSelect = useCallback((url: string) => {
    trace.action('image-tool:select-image', { nodeId, url: url.slice(0, 80), isInMap, mapItemIndex });

    if (isInMap && srcBinding && mapContext) {
      // Map mode: update the data array item's field
      const updatedItem = { ...(mapContext.mapData[mapItemIndex!] || {}), [srcBinding.field]: url };
      queueMutation({ type: 'updateMapItem', varName: mapContext.varName, index: mapItemIndex!, item: updatedItem });
    } else {
      // Direct mode: update the HTML attr
      queueMutation({ type: 'updateHtmlAttrs', nodeId, attrs: { src: url } });
    }

    // Imperative canvas update for instant feedback — the canvas DOM lives
    // in the sandbox iframe, so the attribute patch goes through the bridge.
    getCanvasBridge().setAttribute(nodeId, getViewportPrefix(vpId), 'src', url);
  }, [nodeId, vpId, isInMap, mapItemIndex, srcBinding, mapContext]);

  // ─── Alt text ─────────────────────────────────────────────────────
  const commitAlt = useCallback((value: string) => {
    const trimmed = value.trim();
    trace.action('image-tool:update-alt', { nodeId, alt: trimmed, isInMap, mapItemIndex });

    if (isInMap && altBinding && mapContext) {
      const updatedItem = { ...(mapContext.mapData[mapItemIndex!] || {}), [altBinding.field]: trimmed };
      queueMutation({ type: 'updateMapItem', varName: mapContext.varName, index: mapItemIndex!, item: updatedItem });
    } else {
      queueMutation({ type: 'updateHtmlAttrs', nodeId, attrs: { alt: trimmed } });
    }
  }, [nodeId, isInMap, mapItemIndex, altBinding, mapContext]);

  // ─── Object Fit ───────────────────────────────────────────────────
  const handleFitChange = useCallback((value: string) => {
    trace.action('image-tool:update-object-fit', { nodeId, objectFit: value });
    updateStyle('objectFit', value);
  }, [nodeId, updateStyle]);

  // ─── Object Position ──────────────────────────────────────────────
  const handlePositionChange = useCallback((value: string) => {
    trace.action('image-tool:update-object-position', { nodeId, objectPosition: value });
    updateStyle('objectPosition', value);
  }, [nodeId, updateStyle]);

  trace.fn('ImageTool:render', { nodeId, src: src.slice(0, 60), alt: localAlt, objectFit, objectPosition, isInMap, mapItemIndex, isSrcCmsBound });

  // Source row — single ControlActionRow shape (just like Fill). The
  // swatch shows a thumbnail of the current image, or the alpha-checker
  // pattern when empty. Click anywhere on the row opens the search modal.
  const sourceSwatchStyle: React.CSSProperties = src
    ? { backgroundImage: `url(${src})`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : ALPHA_CHECKER_STYLE;
  const sourceLabel = src ? 'Image' : 'Choose Image';

  return (
    <>
      <ToolSection title="Image" collapsible>
        {/* Source row — ControlLabel handles the binding menu (CMS, variable,
            override) automatically. When CMS-bound, the value column swaps
            to the CmsBoundPill — same convention as Fill's bound state. */}
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Source" property="src" />
          {isSrcCmsBound ? (
            <CmsBoundPill property="src" fallbackValue={src} />
          ) : (
            <ControlActionRow onClick={() => setImageModalOpen(true)}>
              <ColorSwatch size="md" style={sourceSwatchStyle} />
              <span className="text-xs text-[var(--text-primary)] truncate">
                {sourceLabel}
              </span>
            </ControlActionRow>
          )}
        </div>

        {/* Alt text — full ControlLabel (not plain) so users can bind alt
            text to a CMS field via the menu, same way Source binds. */}
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Alt Text" property="alt" />
          <div className="flex items-center gap-2 w-full">
            <ToolInput
              value={localAlt}
              onChange={(val) => {
                setLocalAlt(val);
                commitAlt(val);
              }}
              text
            />
          </div>
        </div>

        {/* Object Fit */}
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Fit" property="objectFit" />
          <ToolSelect
            value={objectFit}
            onChange={handleFitChange}
            options={OBJECT_FIT_OPTIONS}
          />
        </div>

        {/* Object Position */}
        <div className="flex items-center justify-between w-full">
          <ControlLabel label="Position" property="objectPosition" />
          <ToolSelect
            value={objectPosition}
            onChange={handlePositionChange}
            options={OBJECT_POSITION_OPTIONS}
          />
        </div>
      </ToolSection>

      {/* Image Search Modal */}
      <ImageSearchModal
        isOpen={imageModalOpen}
        onClose={() => setImageModalOpen(false)}
        onSelect={handleImageSelect}
      />
    </>
  );
}
