// exit-size.ts — the size a node keeps when it leaves a parent for the canvas.
//
// Every exit path measures the box the node occupied and commits it as
// `width`/`height` in px. For a node that was sizing itself to its CONTENT
// that is wrong: the measurement describes what it happened to be at the
// moment of the drag, not how it was configured. An auto-width text came out
// as a frozen `123px` box — the Dimensions panel flipped from "auto" to a
// number, and editing the text no longer resized it (user report
// 2026-10-05).
//
// Content sizes carry over: `auto`, and the intrinsic keywords `min-content` /
// `max-content` (the editor's own Fit values), which read the content and
// never the parent. A percentage, a stretch or a flex basis was resolved
// AGAINST THE PARENT, which the node no longer has; on the canvas root `100%`
// would mean something entirely different, so for those the measured px
// really is the honest preservation of what the user saw.
//
// TEXT is stricter, because a text with NO width of its own is still an
// auto-width text — the Dimensions panel reads it as "auto" — and the second
// report (2026-10-16, `text-mvaooeph-2`) was exactly that: a bare `<p>` in a
// centred column came out `width: 95px; height: 19px`, and the rounding down
// from 95.19 even wrapped its last letter. A text's auto width also cannot
// stay literally `auto` on the canvas: canvas nodes are absolute children of
// the sandbox content root, which is 0px wide, so `auto` shrink-to-fits
// against nothing and a multi-word text breaks after every word once it sits
// right of x≈0 (measured in Chromium). `max-content` is the auto width that
// survives there — the one TextCreator writes for a click-made canvas text.

import { isTextTag, nodeAcceptsChildren } from '@/shared/constants';

/** Style keys this applies to. */
export type SizeProp = 'width' | 'height';

/** A content-sized value that reads nothing from the parent. */
const CONTENT_SIZES = new Set(['auto', 'min-content', 'max-content']);

/** A text leaf — its words are its content (a link wrapping elements is a frame). */
export function isTextExitNode(
  node: { type?: string; children?: unknown[] } | null | undefined,
): boolean {
  return !!node && isTextTag(node.type || 'div') && !nodeAcceptsChildren(node);
}

/**
 * The value to commit for one axis on exit.
 *
 * @param authored  the node's OWN styles (model, not computed) — computed
 *                  always resolves to px and would defeat the whole point
 * @param prop      which axis
 * @param measured  the px fallback the strategy measured
 * @param text      the node is a text leaf (see {@link isTextExitNode})
 */
export function exitSize(
  authored: Record<string, string | undefined> | undefined | null,
  prop: SizeProp,
  measured: string,
  text = false,
): string {
  const value = (authored?.[prop] ?? '').trim();
  if (text) {
    // Unset / `auto` / `fit-content` all paint as the text's own size inside
    // a parent; on the 0-wide canvas root only `max-content` still does.
    if (prop === 'width' && (value === '' || value === 'auto' || value === 'fit-content')) return 'max-content';
    if (prop === 'height' && value === '') return 'auto';
  }
  return CONTENT_SIZES.has(value) ? value : measured;
}

/** Both axes at once, for the common `{ width, height }` spread. */
export function exitSizes(
  authored: Record<string, string | undefined> | undefined | null,
  measuredWidth: string,
  measuredHeight: string,
  text = false,
): { width: string; height: string } {
  return {
    width: exitSize(authored, 'width', measuredWidth, text),
    height: exitSize(authored, 'height', measuredHeight, text),
  };
}
