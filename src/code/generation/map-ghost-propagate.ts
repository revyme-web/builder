// map-ghost-propagate.ts — Propagate a template (item 0) field change to
// inheriting ghost map items. Lives OUTSIDE map-gen.ts because it queues
// mutations (mutation-queue) while mutation-queue itself imports map-gen's
// pure code-gen functions — keeping this here would be a module cycle.
// Callers are the UI/canvas write paths (CanvasTextEditController,
// ContentControl, ControlProvider).

import { queueMutation } from '../mutation/mutation-queue';

/**
 * Propagate a field change from item 0 (template) to all non-overridden ghost items.
 * A ghost "inherits" when its field value matches the old template value or is undefined.
 * Queues updateMapItem mutations for each inheriting ghost.
 */
export function propagateToGhosts(
  varName: string,
  field: string,
  oldVal: string | undefined,
  newVal: string,
  mapData: Record<string, string>[],
): void {
  for (let i = 1; i < mapData.length; i++) {
    const ghost = mapData[i];
    if (!ghost) continue;
    if (ghost[field] === oldVal || ghost[field] === undefined) {
      const updated = { ...ghost, [field]: newVal };
      queueMutation({ type: 'updateMapItem', varName, index: i, item: updated });
    }
  }
}
