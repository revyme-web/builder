// MapTool.tsx — Inline section for .map() repeater management.
// Shows an orange "Map" section with item list directly in the properties panel.
// Clicking an item selects the ghost on canvas. Add/remove items inline.
// "Edit JSON" opens an interactive JSON editor for the map data array.

import { useState, useCallback, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { selectedNodeAtom, mapItemIndexAtom } from '@/code/stores/store';
import { useNodesComputed } from '@/code/stores/node-family';
import { queueMutation, flushNow, setForceRender } from '@/code/mutation/mutation-queue';
import {  } from '@/code/generation/map-gen';
import { ToolDivider, ControlLabel, ControlActionRow, RemoveButton } from '@/editor/controls';
import ToolPopup from '@/editor/ui/ToolPopup';
import { MAP_TEMPLATE_COLOR } from '@/shared/constants';
import { trace } from '@/shared/debug-trace';
import { JsonEditor, githubDarkTheme } from 'json-edit-react';
import type { CanvasNode } from '@/code/parsing/parser';

// --- MapTool (entry point in PropertiesPanel) --------------------------------

export default function MapTool() {
  const selectedId = useAtomValue(selectedNodeAtom);
  const mapItemIndex = useAtomValue(mapItemIndexAtom);
  const setMapItemIndex = useSetAtom(mapItemIndexAtom);
  const [jsonEditorOpen, setJsonEditorOpen] = useState(false);
  const jsonBtnRef = useRef<HTMLButtonElement>(null);

  // Walk up to find the parent with inline collectionList
  const mapContext = useNodesComputed((nodes) => {
    const node = selectedId ? nodes.get(selectedId) : null;
    if (!node) return null;
    let current: CanvasNode | undefined = node;
    while (current) {
      if (current.isCollectionTemplate) {
        const parent = current.parentId ? nodes.get(current.parentId) : null;
        if (parent?.collectionList?.source?.startsWith('__inline:')) {
          const templateId = parent.collectionList!.templateIds['default']
            || Object.values(parent.collectionList!.templateIds)[0];
          return { parentNode: parent, templateId: templateId || current.id };
        }
      }
      current = current.parentId ? nodes.get(current.parentId) : undefined;
    }
    return null;
  }, [selectedId]);

  const parentNode = mapContext?.parentNode ?? null;
  const mapData = parentNode?.inlineMapData || [];
  const mapVarName = parentNode?.collectionList?.source?.replace('__inline:', '') || '';

  // Determine preview field: first text-like field from item 0
  const previewField = mapData.length > 0 ? Object.keys(mapData[0])[0] : null;

  const handleAddItem = useCallback(() => {
    if (!mapVarName) return;
    const defaultItem: Record<string, string> = mapData.length > 0
      ? { ...mapData[0] }
      : { label: '' };
    trace.action('map-tool:add-item', { varName: mapVarName, fields: Object.keys(defaultItem) });
    queueMutation({ type: 'addMapItem', varName: mapVarName, item: defaultItem });
  }, [mapVarName, mapData]);

  const handleRemoveItem = useCallback((index: number) => {
    if (!mapVarName) return;
    trace.action('map-tool:remove-item', { varName: mapVarName, index });
    queueMutation({ type: 'removeMapItem', varName: mapVarName, index });
  }, [mapVarName]);

  const handleOpenJsonEditor = useCallback(() => {
    setJsonEditorOpen(true);
  }, []);

  const handleJsonUpdate = useCallback(({ newData }: { newData: any }) => {
    if (!mapVarName || !Array.isArray(newData)) return;
    // Flush any pending mutations first
    flushNow();
    // Queue all item updates
    for (let i = 0; i < newData.length; i++) {
      const item = newData[i];
      if (typeof item === 'object' && item !== null) {
        const stringItem: Record<string, string> = {};
        for (const [k, v] of Object.entries(item)) {
          stringItem[k] = String(v);
        }
        queueMutation({ type: 'updateMapItem', varName: mapVarName, index: i, item: stringItem });
      }
    }
    // Force Renderer to rebuild (not skip) since this is a non-canvas-initiated change
    setForceRender();
    flushNow();
    trace.action('map-tool:json-edit', { varName: mapVarName, itemCount: newData.length });
  }, [mapVarName]);

  if (!mapContext) return null;

  const handleItemClick = (idx: number) => {
    setMapItemIndex(idx);
    trace.action('map-tool:select-item', { varName: mapVarName, index: idx });
  };

  trace.fn('MapTool.render', {
    nodeId: selectedId,
    parentId: parentNode!.id,
    varName: mapVarName,
    itemCount: mapData.length,
  });

  return (
    <>
      {/* Orange section title */}
      <div className="px-3">
        <div className="flex items-center justify-between py-2">
          <span className="text-xs font-bold" style={{ color: MAP_TEMPLATE_COLOR }}>Map</span>
          <button
            ref={jsonBtnRef}
            onClick={handleOpenJsonEditor}
            className="text-[10px] px-1.5 py-0.5 cut-corners bg-[var(--button-secondary-bg)] text-[var(--text-secondary)] hover:bg-[var(--button-secondary-hover)] hover:text-[var(--text-primary)] border-none cursor-pointer transition-colors"
            title="Edit map data as JSON"
          >
            ✏ JSON
          </button>
        </div>
        <div className="flex flex-col py-0.5 gap-1.5 pl-4">
          {/* Item list */}
          {mapData.map((item, idx) => (
            <div key={idx} className="flex items-center justify-between w-full">
              <ControlLabel label={`Item ${idx}`} property="" plain />
              <div className="w-full" style={{ width: '129px', minWidth: '129px' }}>
              <ControlActionRow onClick={() => handleItemClick(idx)}>
                <span
                  className="text-[var(--text-secondary)] truncate flex-1"
                  style={{
                    maxWidth: '130px',
                    fontWeight: mapItemIndex === idx ? 600 : 400,
                    color: mapItemIndex === idx ? 'var(--text-primary)' : undefined,
                  }}
                >
                  {previewField && item[previewField]
                    ? item[previewField]
                    : `${Object.keys(item).length} fields`}
                </span>
                <RemoveButton onClick={(e) => { e.stopPropagation(); handleRemoveItem(idx); }} />
              </ControlActionRow>
              </div>
            </div>
          ))}

          {/* Add Item */}
          <div className="flex items-center justify-between w-full">
            <ControlLabel label="" property="" plain />
            <ControlActionRow onClick={handleAddItem}>
              <span className="text-[var(--accent-text)]">+ Add Item</span>
            </ControlActionRow>
          </div>
        </div>
      </div>

      <ToolDivider />

      {/* JSON Editor Popup — opens to the LEFT of the button */}
      <ToolPopup
        isOpen={jsonEditorOpen}
        onClose={() => setJsonEditorOpen(false)}
        title={`Map: ${mapVarName}`}
        anchorRef={jsonBtnRef}
        side="left"
        width={360}
      >
        <div className="jer-map-editor" style={{ maxHeight: '50vh', overflow: 'auto' }}>
          <style>{`.jer-map-editor, .jer-map-editor * { font-size: 11px !important; line-height: 1.4 !important; } .jer-map-editor .jer-value-string { word-break: break-all; }`}</style>
          <JsonEditor
            data={mapData}
            onUpdate={handleJsonUpdate}
            theme={githubDarkTheme}
            rootName={mapVarName}
            collapse={2}
            restrictEdit={false}
            restrictDelete={true}
            restrictAdd={true}
            restrictTypeSelection={['string']}
            showStringQuotes={false}
            indent={2}
            minWidth="100%"
          />
        </div>
      </ToolPopup>
    </>
  );
}
