// motion-reinject.ts — Re-inject framer-motion tag props on pasted nodes.
//
// Copy captures `CanvasNode.motionProps` (initial/whileInView/viewport/
// transition/whileHover/whileTap/animate/exit) per clipboard node; the
// AddNodeDef the executor emits carries ONLY styles/attrs, so without this
// pass every pasted node lost its Appear/Hover/Tap/declarative-Loop
// animation (live find 2026-07-13: chip with an appear width animation
// pasted with an empty Animation section).
//
// Injection rides the SAME mutation queue as the addNode itself — one
// `updateMotionProp` per prop per pasted copy, queued after the creation
// mutations so the tag exists by the time they apply. The generator then
// handles everything downstream: motion.* tag conversion, the framer-motion
// import, literal emission (numbers/booleans/Infinity/arrays unquoted) and
// the scroll-conflict decompose/recompose pass.

import { trace } from '@/shared/debug-trace';
import { queueMutation } from '@/code/mutation/mutation-queue';
import type { ClipboardNode } from '../types';
import type { IdMapper } from '../core/id-mapper';

/**
 * Reduce a parsed motionProps entry to the plain BASE object that transfers
 * on paste, or null when nothing transfers:
 *  - `_variantName` (string variant ref, e.g. `initial="hidden"`) → null:
 *    it points at variant machinery the paste doesn't carry.
 *  - Scoped values (`_scope`/`_chain` markers) → the `_base` object when one
 *    exists (the unscoped value), else null. The scope's gate consts /
 *    variant vars don't exist on the destination, and materialising an
 *    override as always-on would change meaning (a mobile-only appear
 *    firing on desktop).
 *  - Plain flat object → itself, minus any `_`-meta keys.
 */
export function transferableMotionProps(
  raw: Record<string, string>,
): Record<string, string> | null {
  if (raw._variantName !== undefined) return null;
  if (raw._base !== undefined) {
    try {
      const base = JSON.parse(raw._base) as Record<string, string>;
      return Object.keys(base).length > 0 ? base : null;
    } catch {
      return null;
    }
  }
  if (raw._scope !== undefined || raw._chain !== undefined) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!k.startsWith('_')) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Queue `updateMotionProp` writes for every pasted copy of every clipboard
 * node that carried motionProps — descendants included (they ride along
 * inside the root's AddNodeDef but are individually id-mapped).
 */
export function reinjectMotionProps(
  clipboardNodes: ClipboardNode[],
  idMapper: IdMapper,
): void {
  for (const cn of clipboardNodes) {
    const mp = cn.motionProps;
    if (!mp) continue;
    const newIds = idMapper.getNewIdsForClipboard(cn.id);
    if (newIds.length === 0) continue;
    for (const [propName, raw] of Object.entries(mp)) {
      if (!raw) continue;
      const props = transferableMotionProps(raw as Record<string, string>);
      if (!props) {
        trace.action('paste:motion-prop-skipped', { clipboardId: cn.id, propName, reason: 'variant-or-scoped-only' });
        continue;
      }
      for (const newId of newIds) {
        queueMutation({ type: 'updateMotionProp', nodeId: newId, propName, props });
      }
      trace.action('paste:motion-prop-reinjected', { clipboardId: cn.id, propName, copies: newIds.length });
    }
  }
}
