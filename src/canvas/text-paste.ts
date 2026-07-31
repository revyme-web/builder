// text-paste.ts — Convert plain-text clipboard contents into a canvas
// text node.
//
// Fallback path for Ctrl+V when:
//   1. Clipboard has no image (image-paste already handled that).
//   2. Clipboard text is not a Revyme component / plugin URL.
//   3. There's no internal `canvas_clipboard` payload (no prior copy
//      from inside the editor).
// In other words: the user copied real text from elsewhere
// (browser, document, terminal) and pasted onto the canvas. We treat
// that as "create a new text node with this content" — same gesture
// as draw-text + type, just zero clicks.
//
// Goes through the regular paste engine via `overrideClipboard` so
// the text node lands at the right target per the normal paste rules:
//   - Selected frame → text becomes a child
//   - Selected node in a frame → text becomes a sibling
//   - Canvas selection / no selection → text on canvas at visible
//     centre
// Same target resolution, positioning, and replica routing as a
// regular copy+paste — no parallel routing logic to maintain.

import { getDefaultStore } from 'jotai';
import { flushNow } from '@/code/mutation/mutation-queue';
import { executePaste as engineExecutePaste } from '@/code/features/paste-engine';
import type { ClipboardData } from '@/code/features/paste-engine';
import { transformManager } from './transform';
import { getInteractingViewport, getActiveFilePath } from './node-ops';
import { getViewportWidths } from '@/code/stores/viewport-store';
import { generateNodeId } from '@/shared/id-utils';
import { getDefaultTextNodeStyles } from './creators/TextCreator';
import { selectedIdsAtom, nodesAtom } from '@/code/stores/store';
import { trace } from '@/shared/debug-trace';

/** Build the canonical text-paste styles. Mirrors TextCreator's
 *  click-mode defaults: 16 px Inter, black, line-height 1.2,
 *  width: max-content so the node sizes to its content instead of
 *  stretching across the parent. Overrides:
 *   - `whiteSpace: pre-wrap` so newlines in pasted text render as
 *     actual line breaks. Without it, default `white-space: normal`
 *     collapses every `\n` to a single space and a 30-line paste
 *     ends up as one long run-on line.
 *   - `width: auto` (instead of `max-content`) when the text has
 *     newlines, so the longest line dictates width but shorter
 *     lines don't get stretched past their content width. Falls
 *     back to `max-content` for single-line pastes where the
 *     TextCreator default already does the right thing. */
function defaultTextStyles(multiline: boolean): Record<string, string> {
  const base = getDefaultTextNodeStyles('click');
  if (multiline) {
    return {
      ...base,
      whiteSpace: 'pre-wrap',
      // Drop max-content for multi-line — it would size the node to
      // the longest UNWRAPPED line, which can blow past the viewport
      // for wall-of-text pastes. `auto` lets the parent + content
      // dimension it naturally.
      width: 'auto',
    };
  }
  return base;
}

/** Insert the given text as a new canvas text node via the paste
 *  engine. Returns the inserted node id on success, null on failure.
 *  Never throws — errors surface via `trace.error`. */
export function handleClipboardTextPaste(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Build a synthetic ClipboardData wrapping a single text node. The
  // engine then runs the full rule pipeline (selection → target →
  // positioning) exactly as if the user had copied this text node
  // from another canvas. Marking the node `isCanvasNode: true` lets
  // the engine pick canvas-paste rules when nothing is selected; the
  // "paste-into-selected-frame" rule re-routes parent + strips
  // absolute styles automatically when a frame is selected.
  const multiline = trimmed.includes('\n');
  const nodeId = generateNodeId('text');

  // JSX-safety wrap. The generator drops `textContent` directly
  // between the element's open/close tags. If the user pasted code
  // like `<svg><path /></svg>` or `{ foo }`, those characters land
  // unescaped in the source JSX and break the file (`<svg>` is read
  // as a JSX child element; `{` opens an expression container).
  // Wrap in a JSX expression with a JSON-stringified string literal:
  //   <p>{"raw <svg>text</svg>"}</p>
  // - Valid JSX for ANY input (JSON.stringify escapes `"`, `\`,
  //   control chars, and emits `\n` for real newlines so a multi-
  //   line paste stays a single-line source literal).
  // - The parser already handles `JSXExpressionContainer →
  //   StringLiteral` text children (see parser.ts line 606), so
  //   round-trip preserves `node.textContent` correctly.
  const safeText = `{${JSON.stringify(trimmed)}}`;

  const clipboard: ClipboardData = {
    version: 1,
    timestamp: Date.now(),
    nodes: [
      {
        id: nodeId,
        type: 'p',
        parentId: null,
        children: [],
        order: 0,
        styles: defaultTextStyles(multiline),
        name: 'Text',
        textContent: safeText,
        isCanvasNode: true,
      },
    ],
  };

  // Same call-site context as image-paste and `executePaste()` in
  // `code/features/paste-engine/execute-from-ui.ts` — identical paste-engine wiring so
  // text and image pastes are routed by the same target / positioning
  // logic.
  const store = getDefaultStore();
  const selectedIds = store.get(selectedIdsAtom);
  const nodes = store.get(nodesAtom);
  const viewportEl = document.querySelector<HTMLElement>('[data-canvas-viewport]');
  const rect = viewportEl?.getBoundingClientRect();
  const { vpId: interactingVpId } = getInteractingViewport();
  const activeFilePath = getActiveFilePath();

  trace.action('text-paste:insert-start', {
    length: trimmed.length,
    preview: trimmed.slice(0, 60),
  });

  const result = engineExecutePaste({
    selectedIds,
    nodes,
    transform: transformManager.getTransform(),
    containerWidth: rect?.width,
    containerHeight: rect?.height,
    interactingVpId,
    viewportWidths: getViewportWidths(),
    activeFilePath,
    overrideClipboard: clipboard,
  });

  if (result.success && result.createdIds.length > 0) {
    flushNow();
    store.set(selectedIdsAtom, [result.createdIds[0]]);
    trace.action('text-paste:inserted', { id: result.createdIds[0] });
    return result.createdIds[0];
  }

  trace.error('text-paste:engine-failed', { message: result.message });
  return null;
}
