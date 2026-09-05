// border-reinject.ts — Re-inject ::after border-overlay rules on pasted nodes.
//
// The border tool's overlay mode renders through a `[data-id="<id>"]::after`
// rule in the page's <style> block, NOT through the node's inline styles — so
// the AddNodeDef the executor emits carries no trace of it and every pasted
// copy lost its border (user report 2026-07-29). Copy captures the rule BODY
// per clipboard node (`borderAfterCSS`, see copy/index.ts); this pass queues
// one `updateBorderOverlay` per pasted copy — descendants included — so the
// destination file gets its own rule under the NEW id. Covers every paste
// scenario in one place: same page, another page, canvas paste, duplicate
// (which is copy+paste), and cross-project paste — the generator
// (`updateBorderOverlayStyle`) creates the destination's <style> block when
// it doesn't exist yet.

import { trace } from '@/shared/debug-trace';
import { queueMutation } from '@/code/mutation/mutation-queue';
import type { ClipboardNode } from '../types';
import type { IdMapper } from '../core/id-mapper';

/**
 * Queue `updateBorderOverlay` writes for every pasted copy of every clipboard
 * node that carried a border-overlay rule. Rides the same mutation queue as
 * the addNode mutations, so one flush applies creation + border in order.
 */
export function reinjectBorderOverlays(
  clipboardNodes: ClipboardNode[],
  idMapper: IdMapper,
): void {
  for (const cn of clipboardNodes) {
    if (!cn.borderAfterCSS) continue;
    const newIds = idMapper.getNewIdsForClipboard(cn.id);
    if (newIds.length === 0) continue;
    for (const newId of newIds) {
      queueMutation({ type: 'updateBorderOverlay', nodeId: newId, afterCSS: cn.borderAfterCSS });
    }
    trace.action('paste:border-overlay-reinjected', {
      clipboardId: cn.id, copies: newIds.length,
    });
  }
}

/**
 * Same pass for `::placeholder` rules (the Input tool's Placeholder Color):
 * the rule lives in the <style> block keyed by data-id, so every pasted input
 * would silently lose its placeholder color without this.
 */
export function reinjectPlaceholderStyles(
  clipboardNodes: ClipboardNode[],
  idMapper: IdMapper,
): void {
  for (const cn of clipboardNodes) {
    const hasPlaceholder = cn.placeholderStyles && Object.keys(cn.placeholderStyles).length > 0;
    if (!hasPlaceholder && !cn.selectCaretCSS) continue;
    const newIds = idMapper.getNewIdsForClipboard(cn.id);
    if (newIds.length === 0) continue;
    for (const newId of newIds) {
      if (hasPlaceholder) queueMutation({ type: 'updatePseudoStyle', nodeId: newId, pseudo: 'placeholder', styles: cn.placeholderStyles! });
      if (cn.selectCaretCSS) queueMutation({ type: 'updateSelectCaretRule', nodeId: newId, cssBody: cn.selectCaretCSS });
    }
    trace.action('paste:placeholder-styles-reinjected', {
      clipboardId: cn.id, copies: newIds.length, caret: !!cn.selectCaretCSS,
    });
  }
}

/**
 * Same pass for per-breakpoint @media overrides: copy captured each node's
 * band rules as `responsiveBands` (width → camelized styles); one
 * `updateContainerStyle` per band per pasted copy rebuilds them under the NEW
 * id — the generator re-adds `!important` and constructs the destination
 * file's band (with its seams) itself. Without this a duplicate showed base
 * styles on every replica tile, descendants included (live find 2026-09-05).
 */
export function reinjectResponsiveBands(
  clipboardNodes: ClipboardNode[],
  idMapper: IdMapper,
): void {
  for (const cn of clipboardNodes) {
    if (!cn.responsiveBands || cn.responsiveBands.length === 0) continue;
    const newIds = idMapper.getNewIdsForClipboard(cn.id);
    if (newIds.length === 0) continue;
    for (const newId of newIds) {
      for (const band of cn.responsiveBands) {
        queueMutation({ type: 'updateContainerStyle', nodeId: newId, maxWidth: band.maxWidth, styles: band.styles });
      }
    }
    trace.action('paste:responsive-bands-reinjected', {
      clipboardId: cn.id, bands: cn.responsiveBands.length, copies: newIds.length,
    });
  }
}
