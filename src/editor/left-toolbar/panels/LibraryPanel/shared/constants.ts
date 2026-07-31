// LibraryPanel preset category constants + library-panel-internal
// drag constants. Extracted as part of the LibraryPanel folder split.
// Pure data — no React, no jotai.

import type { CategoryConfig, DisplayCategory, AnyCategory } from './types';

export const DATA_CATEGORIES: CategoryConfig[] = [
  { key: 'typography', label: 'Typography', prefix: 'typo', defaultValue: '16px' },
  { key: 'color', label: 'Color', prefix: 'color', defaultValue: '#000000' },
  { key: 'image', label: 'Image', prefix: 'image', defaultValue: '' },
  { key: 'video', label: 'Video', prefix: 'video', defaultValue: '' },
  { key: 'radius', label: 'Radius', prefix: 'radius', defaultValue: '8px' },
  { key: 'spacing', label: 'Padding', prefix: 'space', defaultValue: '16px' },
  { key: 'margin', label: 'Margin', prefix: 'margin', defaultValue: '16px' },
  { key: 'shadow', label: 'Shadow', prefix: 'shadow', defaultValue: '0 2px 4px rgba(0,0,0,0.1)' },
  { key: 'border', label: 'Border', prefix: 'border', defaultValue: '1px solid #000000' },
];

export const DISPLAY_ONLY_CATEGORIES: DisplayCategory[] = [];

export const ALL_CATEGORIES: AnyCategory[] = [
  DATA_CATEGORIES.find(c => c.key === 'typography')!,
  DATA_CATEGORIES.find(c => c.key === 'color')!,
  DATA_CATEGORIES.find(c => c.key === 'image')!,
  DATA_CATEGORIES.find(c => c.key === 'video')!,
  DATA_CATEGORIES.find(c => c.key === 'radius')!,
  DATA_CATEGORIES.find(c => c.key === 'spacing')!, // shows as "Padding"
  DATA_CATEGORIES.find(c => c.key === 'margin')!,
  DATA_CATEGORIES.find(c => c.key === 'border')!,
  DATA_CATEGORIES.find(c => c.key === 'shadow')!,
];

/** Pixels of cursor movement before a library-row pointerdown is treated
 *  as a drag rather than a click. Below this, releasing the pointer
 *  fires the row's normal `onClick` (= open editor). At/above, the
 *  toolbar drag pipeline kicks in.
 *
 *  Earlier this file started the drag synchronously on pointerdown
 *  (matching Insert panel cards) — but every casual click on a row
 *  flashed a ghost + temporarily flipped canvas-interacting, which
 *  was visible noise. 5px gives just enough wiggle room to absorb
 *  trackpad jitter without delaying real drags noticeably. */
export const LIBRARY_DRAG_THRESHOLD_PX = 5;

// Sentinel used on the Project row's `data-folder-drop` attribute.
// Translated back to `null` in the drop handler — `moveFileToFolder`
// treats `null` as "ungroup, sit at the implicit Project root", so
// dropping a row on the Project header pulls it OUT of any folder it
// was previously inside.
export const ROOT_FOLDER_DROP_ID = '__root__';
