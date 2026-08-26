// replica-clears.ts — channel-aware payload fix-up for Position-section writes.
//
// PinControl / PositionTypeControl express "this property must be GONE" as
// `'' = delete` (the base-inline dialect). Routed to a non-primary channel
// (page @container band / component variants object) a delete only removes
// that channel's override key — the base value cascades back, so unpinning
// right/bottom on a variant kept them pinned (user report 2026-08-26).
// Translate those clears into explicit neutral overrides before they leave
// the control. The generators' `'' = remove override` semantic is untouched:
// it is correct for Reset Override (inherit base), which is a DIFFERENT
// intent from unpin/re-type (base must be masked).

import { isPrimaryViewport } from '@/shared/constants';
import { getNodeFromCache, getNodesSnapshot } from '@/code/stores/store';
import { neutralizeReplicaClears } from '@/shared/position-utils';
import { trace } from '@/shared/debug-trace';

export function applyReplicaClearSemantics(
  nodeId: string,
  vpId: string,
  styles: Record<string, string>,
): Record<string, string> {
  if (isPrimaryViewport(vpId)) return styles;
  const node = getNodeFromCache(nodeId) ?? getNodesSnapshot().get(nodeId);
  if (!node) return styles;
  // Solo-replica writes REDIRECT to the base inline channel (node-ops'
  // solo redirect) — there `''` really is a base delete; keep it.
  if (node.attrs?.['data-replica-solo']) return styles;
  const out = neutralizeReplicaClears(styles, node.styles ?? {});
  const translated = Object.keys(out).filter((k) => out[k] !== styles[k]);
  if (translated.length > 0) {
    trace.action('position:replica-clear-neutralized', { nodeId, vpId, keys: translated });
  }
  return out;
}
