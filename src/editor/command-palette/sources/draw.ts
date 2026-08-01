// sources/draw.ts — Canvas tool-mode switches (Frame, Text, shapes, layouts).
//
// These only flip `toolModeAtom`; the actual drawing happens when the
// user drags on the canvas. So activating one from the palette arms the
// tool rather than creating anything — which is why they carry the same
// single-letter shortcuts as the toolbar.

import {
  ShapeSquareIcon,
  ShapeCircleIcon,
  ShapeTriangleIcon,
  ShapePathIcon,
  LayoutRowsIcon,
  LayoutColumnsIcon,
  LayoutGridIcon,
  TextToolbarIcon,
  CursorIcon,
} from '@/shared/icons';
import type { ToolMode } from '@/code/stores/tool-store';
import type { SearchableItem } from '../search-types';
import type { SearchSource } from './types';

const DRAW_TOOLS: Array<{
  id: string;
  name: string;
  mode: ToolMode;
  shortcut?: string;
  keywords: string[];
  icon?: SearchableItem['icon'];
}> = [
  { id: 'select',         name: 'Select',     mode: 'select',         shortcut: 'V',  keywords: ['select', 'pointer', 'cursor', 'move'], icon: CursorIcon },
  { id: 'frame',          name: 'Frame',      mode: 'frame',          shortcut: 'F',  keywords: ['frame', 'container', 'box', 'div'], icon: ShapeSquareIcon },
  { id: 'text',           name: 'Text',       mode: 'text',           shortcut: 'T',  keywords: ['text', 'type', 'label', 'paragraph'], icon: TextToolbarIcon },
  { id: 'layout-rows',    name: 'Rows',       mode: 'layout-rows',    shortcut: '⇧R', keywords: ['rows', 'horizontal', 'layout', 'flex', 'stack'], icon: LayoutRowsIcon },
  { id: 'layout-cols',    name: 'Columns',    mode: 'layout-columns', shortcut: '⇧C', keywords: ['columns', 'vertical', 'layout', 'flex', 'stack'], icon: LayoutColumnsIcon },
  { id: 'layout-grid',    name: 'Grid',       mode: 'layout-grids',   shortcut: '⇧G', keywords: ['grid', 'css grid', 'layout'], icon: LayoutGridIcon },
  { id: 'shape-rect',     name: 'Rectangle',  mode: 'shape-rect',     shortcut: 'R',  keywords: ['rectangle', 'square', 'shape', 'box'], icon: ShapeSquareIcon },
  { id: 'shape-circle',   name: 'Circle',     mode: 'shape-ellipse',  shortcut: 'O',  keywords: ['circle', 'ellipse', 'oval', 'shape'], icon: ShapeCircleIcon },
  { id: 'shape-triangle', name: 'Triangle',   mode: 'shape-triangle', shortcut: '⇧T', keywords: ['triangle', 'polygon', 'shape'], icon: ShapeTriangleIcon },
  { id: 'shape-path',     name: 'Path',       mode: 'shape-path',     shortcut: 'P',  keywords: ['path', 'pen', 'vector', 'bezier'], icon: ShapePathIcon },
  { id: 'sketch',         name: 'Sketch',     mode: 'sketch',         shortcut: 'K',  keywords: ['sketch', 'draw', 'pencil', 'freehand'] },
];

export const drawSource: SearchSource = () =>
  DRAW_TOOLS.map((tool) => ({
    id: `draw:${tool.id}`,
    name: tool.name,
    category: 'draw' as const,
    keywords: [...tool.keywords, 'tool', 'draw', 'create'],
    shortcut: tool.shortcut,
    icon: tool.icon ?? null,
    action: { type: 'set-tool-mode' as const, mode: tool.mode },
  }));
